// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Synthetic same-host API qualification: no models, credentials or network changes.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <array>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
namespace fs = std::filesystem;
struct Handle { HANDLE value = INVALID_HANDLE_VALUE; ~Handle(){if(value && value != INVALID_HANDLE_VALUE) CloseHandle(value);} };
static void check(bool ok, const char* message) { if (!ok) throw std::runtime_error(std::string(message) + ": " + std::to_string(GetLastError())); }
static void writeJson(const fs::path& path, const std::string& value) { std::ofstream output(path); output << value; output.close(); if (!output) throw std::runtime_error("Cannot record synthetic flush result"); }
struct Flush {
    HANDLE pipe;
    std::atomic<bool> stop{false};
    DWORD error = ERROR_IO_PENDING;
    bool success = false;
    static DWORD WINAPI run(void* raw) {
        auto& self = *static_cast<Flush*>(raw);
        if (self.stop.load()) { self.error = ERROR_OPERATION_ABORTED; return 0; }
        self.success = FlushFileBuffers(self.pipe) != 0;
        self.error = self.success ? 0 : GetLastError();
        return 0;
    }
};
// Preserve the stack context even when a later synthetic read/check throws.
// No exception path may close only the thread handle while Flush still runs.
struct FlushGuard {
    Flush& flush; Handle& thread; Handle& client;
    ~FlushGuard() {
        if (WaitForSingleObject(thread.value, 0) == WAIT_OBJECT_0) return;
        flush.stop.store(true);
        const ULONGLONG deadline = GetTickCount64() + 3000;
        while (WaitForSingleObject(thread.value, 0) == WAIT_TIMEOUT && GetTickCount64() < deadline) {
            CancelSynchronousIo(thread.value);
            WaitForSingleObject(thread.value, 10);
        }
        if (WaitForSingleObject(thread.value, 0) == WAIT_OBJECT_0) return;
        CloseHandle(client.value); client.value = INVALID_HANDLE_VALUE;
        CancelSynchronousIo(thread.value);
        if (WaitForSingleObject(thread.value, 2000) != WAIT_OBJECT_0) ExitProcess(50);
    }
};
static std::string oneCase(unsigned index, bool cancel, bool immediate) {
    std::wstring name = L"\\\\.\\pipe\\LOCAL\\YuanZhou.FlushQA." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(index);
    Handle server, client, thread;
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, nullptr);
    check(server.value != INVALID_HANDLE_VALUE, "Create flush QA pipe");
    client.value = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    check(client.value != INVALID_HANDLE_VALUE, "Connect flush QA client");
    // The client has already connected; no pending ConnectNamedPipe operation.
    OVERLAPPED connect{};
    BOOL connected = ConnectNamedPipe(server.value, &connect);
    check(connected || GetLastError() == ERROR_PIPE_CONNECTED, "Observe connected flush pipe");
    std::array<char, 32768> payload; payload.fill('Q');
    Handle writeEvent; writeEvent.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); check(writeEvent.value != nullptr, "Write event");
    OVERLAPPED write{}; write.hEvent = writeEvent.value; DWORD written = 0;
    BOOL queued = WriteFile(server.value, payload.data(), static_cast<DWORD>(payload.size()), &written, &write);
    if (!queued) { check(GetLastError() == ERROR_IO_PENDING, "Queue flush payload"); check(WaitForSingleObject(writeEvent.value, 2000) == WAIT_OBJECT_0, "Payload queue timeout"); check(GetOverlappedResult(server.value, &write, &written, FALSE) != 0, "Payload queued"); }
    check(written == payload.size(), "Full synthetic payload queued");
    Flush flush{server.value};
    thread.value = CreateThread(nullptr, 0, Flush::run, &flush, 0, nullptr); check(thread.value != nullptr, "Create flush thread");
    FlushGuard cleanup{flush, thread, client};
    bool initiallyBlocked = false, cancellationObserved = false;
    const ULONGLONG started = GetTickCount64();
    if (!immediate) initiallyBlocked = WaitForSingleObject(thread.value, 100) == WAIT_TIMEOUT;
    if (cancel) {
        flush.stop.store(true);
        while (WaitForSingleObject(thread.value, 0) == WAIT_TIMEOUT && GetTickCount64() - started < 3000) {
            if (CancelSynchronousIo(thread.value)) cancellationObserved = true;
            WaitForSingleObject(thread.value, 10);
        }
    } else {
        std::array<char, 32768> received{}; DWORD total = 0;
        while (total < received.size()) {
            DWORD count = 0; check(ReadFile(client.value, received.data() + total, static_cast<DWORD>(received.size()) - total, &count, nullptr) && count, "Drain synthetic payload");
            total += count;
        }
        check(received == payload, "Payload preserved");
        WaitForSingleObject(thread.value, 3000);
    }
    bool bounded = WaitForSingleObject(thread.value, 0) == WAIT_OBJECT_0;
    if (!bounded) {
        // Never join an uncancellable thread. Close only our own synthetic
        // client to release the server-side flush, then fail the qualification.
        CloseHandle(client.value); client.value = INVALID_HANDLE_VALUE;
        CancelSynchronousIo(thread.value);
        if (WaitForSingleObject(thread.value, 2000) != WAIT_OBJECT_0) {
            std::cerr << "FLUSH_UNCANCELLABLE_AFTER_CLIENT_CLOSE\n";
            ExitProcess(50);
        }
    }
    bool passed = bounded && (cancel ? !flush.success && flush.error == ERROR_OPERATION_ABORTED : flush.success && flush.error == 0) && (immediate || initiallyBlocked);
    const auto elapsed = GetTickCount64() - started;
    std::string result = "{\"cancel\":" + std::string(cancel ? "true" : "false") + ",\"immediate\":" + (immediate ? "true" : "false") +
        ",\"initiallyBlocked\":" + (initiallyBlocked ? "true" : "false") + ",\"cancelApiSucceeded\":" + (cancellationObserved ? "true" : "false") +
        ",\"flushError\":" + std::to_string(flush.error) + ",\"bounded\":" + (bounded ? "true" : "false") +
        ",\"elapsedMs\":" + std::to_string(elapsed) + ",\"passed\":" + (passed ? "true" : "false") + "}";
    if (!passed) throw std::runtime_error(result);
    return result;
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 2) return 2;
    const fs::path root(argv[1]);
    try {
        if (!root.is_absolute() || fs::exists(root) || root.wstring().rfind(L"\\\\", 0) == 0) throw std::runtime_error("New local absolute QA directory required");
        for (const auto& part : root) if (part == L".." || part == L".") throw std::runtime_error("Dot components forbidden");
        for (fs::path parent = root.parent_path(); !parent.empty();) {
            DWORD attributes = GetFileAttributesW(parent.c_str());
            if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("Ordinary existing parent required");
            auto next = parent.parent_path(); if (next == parent) break; parent = next;
        }
        check(fs::create_directory(root), "Create new flush QA directory");
        std::string results;
        for (unsigned index = 0; index < 5; ++index) {
            auto result = oneCase(index, index != 0, index >= 3);
            writeJson(root / ("case-" + std::to_string(index) + ".json"), result);
            if (!results.empty()) results += ","; results += result;
        }
        writeJson(root / L"summary.json", "{\"scope\":\"synthetic-native-pipe-flush-cancellation\",\"passed\":true,\"cases\":[" + results + "],\"realModelVerified\":false,\"deployable\":false}");
        std::cout << "WINDOWS_BOUNDED_PIPE_FLUSH_OK\n"; return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << "\n"; return 1; }
}
