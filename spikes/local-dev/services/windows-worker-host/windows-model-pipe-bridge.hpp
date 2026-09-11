// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Shared native transport primitive; qualification belongs to each host. Transparent pipe-to-fixed-loopback TLS bytes; never decrypts TLS,
// parses HTTP, stores credentials, accepts destinations from a Worker, or enables network capabilities.
#pragma once
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <sddl.h>
#include <securityappcontainer.h>
#include <array>
#include <atomic>
#include <functional>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ws2_32.lib")

namespace yuan::worker {
class WindowsModelPipeBridge final {
public:
    // Must be called before CreateProcess so the LOCAL alias can be placed in
    // the child environment. Nonce is a fresh controller-generated identifier.
    static std::wstring clientPipeName(const std::wstring& nonce) {
        validateNonce(nonce);
        return L"\\\\.\\pipe\\LOCAL\\YuanZhou.Model." + nonce;
    }
    // Construct after CreateProcess(CREATE_SUSPENDED), before ResumeThread.
    // All four instances exist before any accept thread or Worker code starts.
    // onFailure runs on an I/O thread: it may signal or TerminateJobObject, but
    // MUST NOT destroy this bridge or call stop() inline (that would self-join).
    WindowsModelPipeBridge(PSID appContainerSid, unsigned short fixedLoopbackHttpsPort,
        DWORD suspendedWorkerPid, std::wstring nonce, std::function<void(std::string)> onFailure)
        : port_(fixedLoopbackHttpsPort), workerPid_(suspendedWorkerPid), onFailure_(std::move(onFailure)) {
        validateNonce(nonce);
        if (!appContainerSid || !IsValidSid(appContainerSid) || !port_ || !workerPid_)
            throw std::invalid_argument("Valid SID, fixed loopback port and suspended Worker PID required");
        sid_.resize(GetLengthSid(appContainerSid));
        check(CopySid(static_cast<DWORD>(sid_.size()), sid_.data(), appContainerSid) != 0, "Copy Worker SID");
        try {
            WSADATA data{}; if (WSAStartup(MAKEWORD(2, 2), &data) != 0) throw std::runtime_error("Bridge Winsock initialization failed");
            winsock_ = true;
            stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr); check(stopEvent_ != nullptr, "Bridge stop event");
            workerProcess_ = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, workerPid_);
            check(workerProcess_ != nullptr, "Hold Worker process identity");
            DWORD session = 0; check(ProcessIdToSessionId(workerPid_, &session) != 0, "Worker session ID");
            wchar_t objects[2048]{}; ULONG size = 0;
            check(GetAppContainerNamedObjectPath(nullptr, sid_.data(), 2048, objects, &size) != 0, "Worker named-object namespace");
            const std::wstring sidString = sidText(sid_.data());
            if (std::wstring(objects) != L"AppContainerNamedObjects\\" + sidString)
                throw std::runtime_error("Unsupported Worker named-object namespace");
            clientName_ = clientPipeName(nonce);
            hostName_ = L"\\\\.\\pipe\\Sessions\\" + std::to_wstring(session) + L"\\" + objects + L"\\YuanZhou.Model." + nonce;
            const std::wstring acl = L"D:(A;;GA;;;SY)(A;;GA;;;" + currentUserSid() + L")(A;;GRGW;;;" + sidString + L")S:(ML;;NW;;;LW)";
            PSECURITY_DESCRIPTOR descriptor = nullptr;
            check(ConvertStringSecurityDescriptorToSecurityDescriptorW(acl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != 0, "Bridge pipe ACL");
            struct FreeDescriptor { PSECURITY_DESCRIPTOR value; ~FreeDescriptor(){LocalFree(value);} } freeDescriptor{descriptor};
            SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
            for (size_t i = 0; i < slots_.size(); ++i) {
                slots_[i].pipe = CreateNamedPipeW(hostName_.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED |
                    (i == 0 ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0), PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
                    PIPE_REJECT_REMOTE_CLIENTS, static_cast<DWORD>(slots_.size()), 65536, 65536, 0, &security);
                check(slots_[i].pipe != INVALID_HANDLE_VALUE, "Precreate all fixed bridge instances");
            }
        } catch (...) { closeResources(); throw; }
    }
    WindowsModelPipeBridge(const WindowsModelPipeBridge&) = delete;
    WindowsModelPipeBridge& operator=(const WindowsModelPipeBridge&) = delete;
    ~WindowsModelPipeBridge() { stop(); closeResources(); }
    const std::wstring& clientName() const noexcept { return clientName_; }
    const std::wstring& hostName() const noexcept { return hostName_; }
    void start() {
        if (started_ || stopping_.load()) throw std::logic_error("Bridge may start exactly once");
        started_ = true;
        try { for (auto& slot : slots_) { auto* current = &slot; slot.thread = std::thread([this, current]{ serve(current->pipe); }); } }
        catch (...) { stop(); throw; }
    }
    void stop() noexcept {
        requestStop();
        for (auto& slot : slots_) if (slot.thread.joinable()) slot.thread.join();
    }
    bool failed() const noexcept { return failed_.load(); }
    unsigned long long connections() const noexcept { return connections_.load(); }
    unsigned long long tailDrains() const noexcept { return tailDrains_.load(); }
    unsigned long long tailDrainCancels() const noexcept { return tailDrainCancels_.load(); }
    std::string failure() const { std::lock_guard<std::mutex> lock(errorMutex_); return error_; }
private:
    static constexpr DWORD bufferSize = 16384;
    static constexpr DWORD idleTimeoutMs = 120000;
    struct Slot { HANDLE pipe = INVALID_HANDLE_VALUE; std::thread thread; };
    struct OwnedHandle {
        HANDLE value = nullptr;
        ~OwnedHandle(){if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);}
    };
    struct Operation {
        OwnedHandle event; OVERLAPPED overlapped{};
        Operation() { event.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); check(event.value != nullptr, "Bridge I/O event"); overlapped.hEvent = event.value; }
    };
    struct Connection {
        SOCKET socket = INVALID_SOCKET; OwnedHandle done; std::thread downstream;
        Connection() { done.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); check(done.value != nullptr, "Bridge connection event"); }
        void finish() noexcept { SetEvent(done.value); if (socket != INVALID_SOCKET) shutdown(socket, SD_BOTH); }
        ~Connection(){finish(); if (downstream.joinable()) downstream.join(); if (socket != INVALID_SOCKET) closesocket(socket);}
    };
    struct FlushContext {
        HANDLE pipe;
        std::atomic<bool> cancel{false};
        bool success = false;
        DWORD error = ERROR_IO_PENDING;
        static DWORD WINAPI run(void* raw) {
            auto& context = *static_cast<FlushContext*>(raw);
            if (context.cancel.load()) { context.error = ERROR_OPERATION_ABORTED; return 0; }
            context.success = FlushFileBuffers(context.pipe) != 0;
            context.error = context.success ? 0 : GetLastError();
            return 0;
        }
    };
    static void validateNonce(const std::wstring& nonce) {
        if (nonce.empty() || nonce.size() > 96) throw std::invalid_argument("Invalid fresh bridge nonce");
        for (wchar_t c : nonce) if (!((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') ||
            (c >= L'0' && c <= L'9') || c == L'-' || c == L'.')) throw std::invalid_argument("Invalid bridge nonce characters");
    }
    static void check(bool ok, const char* operation) {
        if (!ok) throw std::runtime_error(std::string(operation) + ": " + std::to_string(GetLastError()));
    }
    static std::wstring sidText(PSID sid) {
        LPWSTR text = nullptr; check(ConvertSidToStringSidW(sid, &text) != 0, "SID text");
        std::wstring result(text); LocalFree(text); return result;
    }
    static std::wstring currentUserSid() {
        OwnedHandle token; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) != 0, "Bridge user token");
        DWORD size = 0; GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
        std::vector<unsigned char> buffer(size);
        check(GetTokenInformation(token.value, TokenUser, buffer.data(), size, &size) != 0, "Bridge user SID");
        return sidText(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid);
    }
    void requestStop() noexcept { stopping_.store(true); if (stopEvent_) SetEvent(stopEvent_); }
    void fail(const std::string& reason) noexcept {
        bool first = !failed_.exchange(true);
        if (first) { std::lock_guard<std::mutex> lock(errorMutex_); error_ = reason; }
        requestStop();
        if (first && onFailure_) { try { onFailure_(reason); } catch (...) {} }
    }
    void closeResources() noexcept {
        for (auto& slot : slots_) if (slot.pipe != INVALID_HANDLE_VALUE) { CloseHandle(slot.pipe); slot.pipe = INVALID_HANDLE_VALUE; }
        if (workerProcess_) { CloseHandle(workerProcess_); workerProcess_ = nullptr; }
        if (stopEvent_) { CloseHandle(stopEvent_); stopEvent_ = nullptr; }
        if (winsock_) { WSACleanup(); winsock_ = false; }
    }
    bool stopped(HANDLE connectionDone = nullptr) const noexcept {
        return stopping_.load() || (connectionDone && WaitForSingleObject(connectionDone, 0) == WAIT_OBJECT_0);
    }
    static bool peerDisconnected(int error) noexcept {
        return error == WSAECONNRESET || error == WSAECONNABORTED || error == WSAESHUTDOWN ||
            error == WSAENOTCONN || error == WSAEDISCON;
    }
    static void cancelAndDrain(HANDLE pipe, Operation& operation) noexcept {
        CancelIoEx(pipe, &operation.overlapped); DWORD ignored = 0;
        GetOverlappedResult(pipe, &operation.overlapped, &ignored, TRUE);
    }
    bool complete(HANDLE pipe, Operation& operation, BOOL started, DWORD error, DWORD& count,
        HANDLE connectionDone, DWORD timeout) {
        if (started || error == ERROR_PIPE_CONNECTED) return true;
        if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED || error == ERROR_NO_DATA) return false;
        if (error != ERROR_IO_PENDING) {
            if (error == ERROR_OPERATION_ABORTED && stopped(connectionDone)) return false;
            throw std::runtime_error("Bridge pipe operation failed: " + std::to_string(error));
        }
        HANDLE waits[4]{stopEvent_, workerProcess_, nullptr, nullptr}; DWORD countWaits = 2;
        if (connectionDone) waits[countWaits++] = connectionDone;
        DWORD eventIndex = countWaits; waits[countWaits++] = operation.event.value;
        DWORD waited = WaitForMultipleObjects(countWaits, waits, FALSE, timeout);
        if (waited != WAIT_OBJECT_0 + eventIndex) {
            cancelAndDrain(pipe, operation);
            if (waited == WAIT_OBJECT_0 + 1) requestStop();
            if (waited == WAIT_TIMEOUT) throw std::runtime_error("Bridge pipe I/O timeout");
            if (waited == WAIT_FAILED) throw std::runtime_error("Bridge I/O wait failed");
            return false;
        }
        if (!GetOverlappedResult(pipe, &operation.overlapped, &count, FALSE)) {
            error = GetLastError();
            if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED || error == ERROR_NO_DATA ||
                (error == ERROR_OPERATION_ABORTED && stopped(connectionDone))) return false;
            throw std::runtime_error("Bridge pipe completion failed: " + std::to_string(error));
        }
        return true;
    }
    bool pipeRead(HANDLE pipe, char* bytes, DWORD& count, HANDLE done, DWORD timeout = idleTimeoutMs) {
        Operation operation; count = 0;
        BOOL started = ReadFile(pipe, bytes, bufferSize, &count, &operation.overlapped); DWORD error = GetLastError();
        return complete(pipe, operation, started, error, count, done, timeout) && count != 0;
    }
    bool pipeWrite(HANDLE pipe, const char* bytes, DWORD length, HANDLE done) {
        DWORD offset = 0;
        while (offset < length && !stopped(done)) {
            Operation operation; DWORD count = 0;
            BOOL started = WriteFile(pipe, bytes + offset, length - offset, &count, &operation.overlapped); DWORD error = GetLastError();
            if (!complete(pipe, operation, started, error, count, done, idleTimeoutMs)) return false;
            if (!count) throw std::runtime_error("Bridge pipe made no write progress");
            offset += count;
        }
        return offset == length;
    }
    bool drainPipeTail(HANDLE pipe, HANDLE connectionDone) {
        if (stopped(connectionDone)) return false;
        FlushContext context{pipe};
        OwnedHandle thread;
        thread.value = CreateThread(nullptr, 0, FlushContext::run, &context, 0, nullptr);
        check(thread.value != nullptr, "Bridge tail-drain thread");
        // The main pump keeps observing client closure while this thread waits.
        // Flush confirms that queued pipe bytes were actually read, unlike a
        // completed WriteFile. A full client close needs no reverse drain.
        HANDLE waits[]{stopEvent_, workerProcess_, connectionDone, thread.value};
        DWORD waited = WaitForMultipleObjects(4, waits, FALSE, 5000);
        bool cancelRequested = waited != WAIT_OBJECT_0 + 3;
        if (cancelRequested) {
            context.cancel.store(true);
            tailDrainCancels_.fetch_add(1);
            // Repeat cancellation to cover the pre-Flush scheduling window.
            // Never join an outstanding synchronous call without a deadline.
            ULONGLONG deadline = GetTickCount64() + 3000;
            while (WaitForSingleObject(thread.value, 0) == WAIT_TIMEOUT && GetTickCount64() < deadline) {
                CancelSynchronousIo(thread.value);
                WaitForSingleObject(thread.value, 10);
            }
            if (WaitForSingleObject(thread.value, 0) != WAIT_OBJECT_0) {
                fail("Bridge tail-drain cancellation did not complete");
                // The controller failure callback terminates the Worker Job,
                // which also closes the peer. Do not release the stack context
                // or allow an unbounded join if even that cannot end the call.
                if (WaitForSingleObject(thread.value, 1000) != WAIT_OBJECT_0) std::terminate();
            }
            if (waited == WAIT_OBJECT_0 + 1) requestStop();
            if (waited == WAIT_TIMEOUT) throw std::runtime_error("Bridge tail drain timed out");
            if (waited == WAIT_FAILED) throw std::runtime_error("Bridge tail-drain wait failed");
            return false;
        }
        // The thread handle is signalled before context is inspected or freed.
        if (context.success) { tailDrains_.fetch_add(1); return true; }
        if (context.error == ERROR_BROKEN_PIPE || context.error == ERROR_PIPE_NOT_CONNECTED ||
            context.error == ERROR_NO_DATA || (context.error == ERROR_OPERATION_ABORTED && stopped(connectionDone))) return false;
        throw std::runtime_error("Bridge tail-drain flush failed: " + std::to_string(context.error));
    }
    void verifyClient(HANDLE pipe) {
        ULONG pid = 0;
        check(GetNamedPipeClientProcessId(pipe, &pid) != 0 && pid == workerPid_, "Bridge Worker PID mismatch");
        check(ImpersonateNamedPipeClient(pipe) != 0, "Bridge client token identification");
        // Continuing a privileged broker thread after failed RevertToSelf is
        // unsafe. Termination closes the launcher's kill-on-close Job as well.
        struct Revert { ~Revert(){if (!RevertToSelf()) std::terminate();} } revert;
        OwnedHandle token; check(OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token.value) != 0, "Bridge client token");
        DWORD appContainer = 0, returned = 0;
        check(GetTokenInformation(token.value, TokenIsAppContainer, &appContainer, sizeof(appContainer), &returned) != 0 && appContainer == 1,
            "Bridge client is not AppContainer");
        DWORD size = 0; GetTokenInformation(token.value, TokenAppContainerSid, nullptr, 0, &size);
        std::vector<unsigned char> info(size);
        check(GetTokenInformation(token.value, TokenAppContainerSid, info.data(), size, &size) != 0 &&
            EqualSid(reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(info.data())->TokenAppContainer, sid_.data()) != 0,
            "Bridge Worker AppContainer SID mismatch");
    }
    SOCKET connectLoopback() {
        SOCKET socket = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (socket == INVALID_SOCKET) throw std::runtime_error("Bridge socket creation failed");
        try {
            u_long nonblocking = 1; if (ioctlsocket(socket, FIONBIO, &nonblocking) != 0) throw std::runtime_error("Bridge socket mode failed");
            sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); address.sin_port = htons(port_);
            int connected = connect(socket, reinterpret_cast<sockaddr*>(&address), sizeof(address));
            if (connected == SOCKET_ERROR) {
                int error = WSAGetLastError(); if (error != WSAEWOULDBLOCK) throw std::runtime_error("Fixed bridge upstream connect failed: " + std::to_string(error));
                ULONGLONG deadline = GetTickCount64() + 10000; bool ready = false;
                while (!stopping_.load() && GetTickCount64() < deadline) {
                    WSAPOLLFD descriptor{socket, POLLWRNORM, 0}; int result = WSAPoll(&descriptor, 1, 100);
                    if (result == SOCKET_ERROR) throw std::runtime_error("Bridge connect polling failed");
                    if (result > 0) { int size = sizeof(error); if (getsockopt(socket, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &size) != 0 || error)
                            throw std::runtime_error("Fixed bridge upstream connect rejected"); ready = true; break; }
                }
                if (!ready) throw std::runtime_error("Fixed bridge upstream connect timed out or stopped");
            }
            nonblocking = 0; if (ioctlsocket(socket, FIONBIO, &nonblocking) != 0) throw std::runtime_error("Bridge socket blocking mode failed");
            DWORD timeout = 1000;
            if (setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout)) != 0 ||
                setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout)) != 0)
                throw std::runtime_error("Bridge socket deadlines failed");
            return socket;
        } catch (...) { closesocket(socket); throw; }
    }
    bool socketWrite(Connection& connection, const char* bytes, DWORD length) {
        DWORD offset = 0; ULONGLONG deadline = GetTickCount64() + idleTimeoutMs;
        while (offset < length && !stopped(connection.done.value)) {
            int count = send(connection.socket, bytes + offset, static_cast<int>(length - offset), 0);
            if (count > 0) { offset += static_cast<DWORD>(count); deadline = GetTickCount64() + idleTimeoutMs; continue; }
            if (count == 0) return false;
            int error = WSAGetLastError();
            if (peerDisconnected(error)) return false;
            if (error == WSAETIMEDOUT && GetTickCount64() < deadline) continue;
            if (stopped(connection.done.value)) return false;
            throw std::runtime_error("Bridge upstream write failed: " + std::to_string(error));
        }
        return offset == length;
    }
    void serve(HANDLE pipe) noexcept {
        try {
            while (!stopping_.load()) {
                Operation accept; DWORD count = 0; BOOL connected = ConnectNamedPipe(pipe, &accept.overlapped); DWORD error = GetLastError();
                if (!complete(pipe, accept, connected, error, count, nullptr, INFINITE)) {
                    if (stopping_.load()) break;
                    // A client may close before accept completes. Keep the
                    // precreated instance and return it to the accept loop.
                    if (!DisconnectNamedPipe(pipe) && GetLastError() != ERROR_PIPE_NOT_CONNECTED)
                        throw std::runtime_error("Bridge early-disconnect reset failed");
                    continue;
                }
                {
                    char buffer[bufferSize];
                    if (pipeRead(pipe, buffer, count, nullptr, 10000)) {
                        verifyClient(pipe); // Revert completes before any socket is opened.
                        Connection connection; connection.socket = connectLoopback();
                        if (socketWrite(connection, buffer, count)) {
                            connections_.fetch_add(1);
                            connection.downstream = std::thread([this, pipe, &connection] {
                                try {
                                    char bytes[bufferSize]; ULONGLONG deadline = GetTickCount64() + idleTimeoutMs;
                                    while (!stopped(connection.done.value)) {
                                        int received = recv(connection.socket, bytes, sizeof(bytes), 0);
                                        if (received > 0) { deadline = GetTickCount64() + idleTimeoutMs; if (!pipeWrite(pipe, bytes, static_cast<DWORD>(received), connection.done.value)) break; }
                                        else if (received == 0) { drainPipeTail(pipe, connection.done.value); break; }
                                        else { int error = WSAGetLastError(); if (peerDisconnected(error)) break;
                                            if (error == WSAETIMEDOUT && GetTickCount64() < deadline) continue;
                                            if (stopped(connection.done.value)) break; throw std::runtime_error("Bridge upstream read failed: " + std::to_string(error)); }
                                    }
                                } catch (const std::exception& error) { if (!stopping_.load()) fail(error.what()); }
                                connection.finish();
                            });
                            while (pipeRead(pipe, buffer, count, connection.done.value) && socketWrite(connection, buffer, count)) {}
                        }
                    }
                } // Connection signals, shuts down and joins before the instance is reused.
                if (!DisconnectNamedPipe(pipe) && GetLastError() != ERROR_PIPE_NOT_CONNECTED)
                    throw std::runtime_error("Bridge instance disconnect failed");
            }
        } catch (const std::exception& error) { if (!stopping_.load()) fail(error.what()); }
        catch (...) { if (!stopping_.load()) fail("Unknown bridge failure"); }
    }
    unsigned short port_; DWORD workerPid_;
    std::function<void(std::string)> onFailure_;
    std::vector<unsigned char> sid_;
    std::wstring clientName_, hostName_;
    std::array<Slot, 4> slots_{};
    HANDLE stopEvent_ = nullptr, workerProcess_ = nullptr;
    bool winsock_ = false, started_ = false;
    std::atomic<bool> stopping_{false}, failed_{false};
    std::atomic<unsigned long long> connections_{0};
    std::atomic<unsigned long long> tailDrains_{0}, tailDrainCancels_{0};
    mutable std::mutex errorMutex_; std::string error_;
};
} // namespace yuan::worker
