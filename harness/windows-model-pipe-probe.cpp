// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Synthetic native IPC qualification only. No credentials, model or network exemptions.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <aclapi.h>
#include <securityappcontainer.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#pragma comment(lib, "advapi32.lib")
#ifndef YUAN_PIPE_CHILD
#pragma comment(lib, "userenv.lib")
#endif
namespace fs = std::filesystem;
constexpr DWORD narrowAccess = FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
struct Handle {
    HANDLE value = nullptr;
    Handle() = default;
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
static void require(bool ok, const char* operation) {
    if (!ok) throw std::runtime_error(std::string(operation) + ": " + std::to_string(GetLastError()));
}
static void writeText(const fs::path& path, const std::string& value) {
    std::ofstream stream(path); stream << value; stream.close();
    if (!stream) throw std::runtime_error("Synthetic output write failed");
}
[[maybe_unused]] static std::wstring quote(const std::wstring& value) {
    if (value.find_first_of(L"\"\r\n") != std::wstring::npos) throw std::runtime_error("Invalid argument");
    return L"\"" + value + L"\"";
}
[[maybe_unused]] static DWORD attemptInstance(const std::wstring& name, bool first) {
    Handle server;
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 256, 256, 0, nullptr);
    return server.value == INVALID_HANDLE_VALUE ? GetLastError() : 0;
}
#ifdef YUAN_PIPE_CHILD
int wmain(int argc, wchar_t** argv) {
    if (argc != 7) return 2;
    const std::wstring mode = argv[1], pipeName = argv[3];
    const fs::path own = argv[2];
    const DWORD expectedServer = std::stoul(argv[4]);
    const bool generic = std::wstring(argv[5]) == L"generic";
    const fs::path resultPath = own / argv[6];
    try {
        if (mode == L"preoccupy") {
            Handle server;
            server.value = CreateNamedPipeW(pipeName.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 256, 256, 0, nullptr);
            DWORD error = server.value == INVALID_HANDLE_VALUE ? GetLastError() : 0;
            writeText(resultPath, "{\"preoccupyError\":" + std::to_string(error) + "}");
            if (!error) { writeText(own / L"preoccupy-ready", "ready"); Sleep(10000); }
            return error ? 3 : 0;
        }
        Handle pipe;
        pipe.value = CreateFileW(pipeName.c_str(), generic ? GENERIC_READ | GENERIC_WRITE : narrowAccess,
            0, nullptr, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
        DWORD error = pipe.value == INVALID_HANDLE_VALUE ? GetLastError() : 0;
        if (mode == L"denied" || mode == L"generic-denied") {
            writeText(resultPath, "{\"connectError\":" + std::to_string(error) + "}");
            return error == ERROR_ACCESS_DENIED ? 0 : 4;
        }
        require(error == 0, "Allowed AppContainer pipe connect");
        ULONG serverPid = 0;
        require(GetNamedPipeServerProcessId(pipe.value, &serverPid) != 0, "Client server PID");
        require(serverPid == expectedServer, "Client server PID mismatch");
        DWORD count = 0; char reply[16]{};
        require(WriteFile(pipe.value, "SYNTHETIC_HELLO", 15, &count, nullptr) && count == 15, "Client pipe write");
        require(ReadFile(pipe.value, reply, sizeof(reply), &count, nullptr) && count == 3 && std::string(reply, count) == "ACK", "Client pipe reply");
        DWORD extraError = attemptInstance(pipeName, false);
        DWORD firstError = attemptInstance(pipeName, true);
        const DWORD expectedExtra = generic ? static_cast<DWORD>(ERROR_PIPE_BUSY) : static_cast<DWORD>(ERROR_ACCESS_DENIED);
        bool ok = extraError == expectedExtra && firstError == ERROR_ACCESS_DENIED;
        writeText(resultPath, "{\"connectError\":0,\"serverPidMatched\":true,\"extraInstanceError\":" +
            std::to_string(extraError) + ",\"firstInstanceError\":" + std::to_string(firstError) +
            ",\"passed\":" + (ok ? "true" : "false") + "}");
        return ok ? 0 : 5;
    } catch (const std::exception& error) { writeText(resultPath, "{\"passed\":false,\"error\":\"" + std::string(error.what()) + "\"}"); return 10; }
}
#else
static void grant(const fs::path& path, PSID sid, DWORD access, bool inherit) {
    PACL oldAcl = nullptr, newAcl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD result = GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &oldAcl, nullptr, &descriptor);
    if (result != ERROR_SUCCESS) throw std::runtime_error("Read new QA ACL: " + std::to_string(result));
    EXPLICIT_ACCESSW entry{}; entry.grfAccessPermissions = access; entry.grfAccessMode = GRANT_ACCESS;
    entry.grfInheritance = inherit ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
    entry.Trustee.TrusteeForm = TRUSTEE_IS_SID; entry.Trustee.ptstrName = static_cast<LPWSTR>(sid);
    result = SetEntriesInAclW(1, &entry, oldAcl, &newAcl);
    if (result == ERROR_SUCCESS) result = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION, nullptr, nullptr, newAcl, nullptr);
    LocalFree(newAcl); LocalFree(descriptor);
    if (result != ERROR_SUCCESS) throw std::runtime_error("Grant new QA ACL: " + std::to_string(result));
}
static void labelLow(const fs::path& path) {
    PSECURITY_DESCRIPTOR descriptor = nullptr; PACL acl = nullptr; BOOL present = FALSE, defaulted = FALSE;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;OICI;NW;;;LW)", SDDL_REVISION_1, &descriptor, nullptr) != 0, "Low label descriptor");
    require(GetSecurityDescriptorSacl(descriptor, &present, &acl, &defaulted) != 0, "Low label ACL");
    DWORD result = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION,
        nullptr, nullptr, nullptr, acl);
    LocalFree(descriptor); if (result != 0) throw std::runtime_error("Low label assignment failed");
}
static std::wstring sidText(PSID sid) {
    LPWSTR text = nullptr; require(ConvertSidToStringSidW(sid, &text) != 0, "SID string");
    std::wstring result(text); LocalFree(text); return result;
}
struct Profile {
    std::wstring name; PSID sid = nullptr;
    bool clean() { bool ok = !sid || SUCCEEDED(DeleteAppContainerProfile(name.c_str())); if (sid) FreeSid(sid); sid = nullptr; return ok; }
    ~Profile() { clean(); }
};
struct Child {
    Handle job, process, thread;
    DWORD pid = 0;
    ~Child() { if (job.value) { CloseHandle(job.value); job.value = nullptr; } if (process.value) WaitForSingleObject(process.value, 5000); }
    DWORD wait() { require(WaitForSingleObject(process.value, 10000) == WAIT_OBJECT_0, "Child timeout"); DWORD code = 0; GetExitCodeProcess(process.value, &code); return code; }
};
static void launch(Child& child, const fs::path& root, const fs::path& own, PSID sid,
    const std::wstring& mode, const std::wstring& pipe, bool generic, const std::wstring& result) {
    child.job.value = CreateJobObjectW(nullptr, nullptr); require(child.job.value != nullptr, "Create child Job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    require(SetInformationJobObject(child.job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != 0, "Child Job limits");
    SIZE_T bytes = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
    std::vector<unsigned char> buffer(bytes); auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(buffer.data());
    require(InitializeProcThreadAttributeList(attributes, 1, 0, &bytes) != 0, "Child attributes");
    struct Guard { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Guard(){DeleteProcThreadAttributeList(value);} } guard{attributes};
    SECURITY_CAPABILITIES capabilities{}; capabilities.AppContainerSid = sid;
    require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities,
        sizeof(capabilities), nullptr, nullptr) != 0, "Child AppContainer");
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes;
    wchar_t desktop[] = L"winsta0\\default"; startup.StartupInfo.lpDesktop = desktop;
    wchar_t windows[MAX_PATH]{}; GetWindowsDirectoryW(windows, MAX_PATH);
    std::wstring environment;
    for (const auto& variable : std::vector<std::wstring>{L"APPDATA=" + own.wstring(), L"LOCALAPPDATA=" + own.wstring(),
        L"SystemDrive=" + std::wstring(windows).substr(0, 2), L"SystemRoot=" + std::wstring(windows),
        L"TEMP=" + own.wstring(), L"TMP=" + own.wstring(), L"USERPROFILE=" + own.wstring(), L"WINDIR=" + std::wstring(windows)}) {
        environment += variable; environment.push_back(0);
    }
    environment.push_back(0);
    std::wstring command = quote((root / L"child.exe").wstring()) + L" " + mode + L" " + quote(own.wstring()) + L" " + quote(pipe) +
        L" " + std::to_wstring(GetCurrentProcessId()) + (generic ? L" generic " : L" narrow ") + quote(result);
    PROCESS_INFORMATION info{};
    require(CreateProcessW((root / L"child.exe").c_str(), command.data(), nullptr, nullptr, FALSE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
        environment.data(), own.c_str(), &startup.StartupInfo, &info) != 0, "Launch pipe child");
    child.process.value = info.hProcess; child.thread.value = info.hThread; child.pid = info.dwProcessId;
    if (!AssignProcessToJobObject(child.job.value, child.process.value)) {
        DWORD error = GetLastError(); TerminateProcess(child.process.value, 13); WaitForSingleObject(child.process.value, 5000);
        SetLastError(error); require(false, "Assign pipe child Job");
    }
    require(ResumeThread(child.thread.value) != static_cast<DWORD>(-1), "Resume pipe child");
}
static HANDLE makePipe(const std::wstring& name, const std::wstring& owner, PSID sid, bool generic) {
    const std::wstring acl = L"D:(A;;GA;;;SY)(A;;GA;;;" + owner + L")(A;;" +
        (generic ? L"GRGW" : L"0x00100083") + L";;;" + sidText(sid) + L")S:(ML;;NW;;;LW)";
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(acl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != 0, "Pipe SID ACL");
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
    HANDLE pipe = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 1024, 1024, 0, &security);
    DWORD error = GetLastError(); LocalFree(descriptor); SetLastError(error); return pipe;
}
struct Operation {
    Handle event; OVERLAPPED overlapped{};
    Operation() { event.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); require(event.value != nullptr, "IPC event"); overlapped.hEvent = event.value; }
};
static void complete(HANDLE pipe, Operation& operation, BOOL started, DWORD* bytes = nullptr) {
    if (!started) {
        DWORD error = GetLastError();
        if (error == ERROR_PIPE_CONNECTED) return;
        SetLastError(error); require(error == ERROR_IO_PENDING, "Start overlapped IPC");
        if (WaitForSingleObject(operation.event.value, 8000) != WAIT_OBJECT_0) {
            CancelIoEx(pipe, &operation.overlapped); DWORD ignored = 0; GetOverlappedResult(pipe, &operation.overlapped, &ignored, TRUE);
            throw std::runtime_error("Bounded named-pipe operation timeout");
        }
        DWORD count = 0; require(GetOverlappedResult(pipe, &operation.overlapped, &count, FALSE) != 0, "Complete IPC");
        if (bytes) *bytes = count;
    }
}
static void verifyClient(HANDLE pipe, DWORD expectedPid, PSID expectedSid) {
    ULONG pid = 0; require(GetNamedPipeClientProcessId(pipe, &pid) != 0 && pid == expectedPid, "Server client PID mismatch");
    require(ImpersonateNamedPipeClient(pipe) != 0, "Identify pipe client");
    struct RevertGuard { ~RevertGuard(){RevertToSelf();} } revert;
    Handle token; require(OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token.value) != 0, "Client token query");
    DWORD isContainer = 0, returned = 0;
    require(GetTokenInformation(token.value, TokenIsAppContainer, &isContainer, sizeof(isContainer), &returned) != 0 && isContainer == 1, "Pipe client is not AppContainer");
    DWORD size = 0; GetTokenInformation(token.value, TokenAppContainerSid, nullptr, 0, &size);
    std::vector<unsigned char> buffer(size);
    require(GetTokenInformation(token.value, TokenAppContainerSid, buffer.data(), size, &size) != 0, "Pipe client container SID");
    auto info = reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(buffer.data());
    require(EqualSid(info->TokenAppContainer, expectedSid) != 0, "Pipe client container SID mismatch");
    size = 0; GetTokenInformation(token.value, TokenCapabilities, nullptr, 0, &size);
    std::vector<unsigned char> capabilities(size);
    require(GetTokenInformation(token.value, TokenCapabilities, capabilities.data(), size, &size) != 0 &&
        reinterpret_cast<TOKEN_GROUPS*>(capabilities.data())->GroupCount == 0, "Pipe client capabilities not empty");
}
static void authorizedRoundtrip(HANDLE pipe, const fs::path& root, PSID sid, const std::wstring& name, bool generic, const std::wstring& result) {
    Operation connect; BOOL started = ConnectNamedPipe(pipe, &connect.overlapped);
    DWORD connectError = GetLastError();
    Child child; launch(child, root, root / L"alice", sid, L"allowed", name, generic, result);
    SetLastError(connectError);
    complete(pipe, connect, started);
    Operation read; DWORD count = 0; char message[64]{};
    complete(pipe, read, ReadFile(pipe, message, sizeof(message), &count, &read.overlapped), &count);
    require(count == 15 && std::string(message, count) == std::string("SYNTHETIC_HELLO", 15), "Synthetic pipe payload");
    verifyClient(pipe, child.pid, sid);
    Operation write; count = 0; complete(pipe, write, WriteFile(pipe, "ACK", 3, &count, &write.overlapped), &count);
    require(count == 3, "Synthetic ACK write");
    require(child.wait() == 0, "Allowed child checks failed");
    require(DisconnectNamedPipe(pipe) != 0, "Disconnect preserved instance");
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 2) { std::cerr << "Usage: windows-model-pipe-probe.exe NEW_ABSOLUTE_QA_DIRECTORY\n"; return 2; }
    const fs::path root(argv[1]); Profile alice, bob; bool rootCreated = false, passed = false;
    std::string failure;
    try {
        if (!root.is_absolute() || root.wstring().rfind(L"\\\\", 0) == 0 || fs::exists(root)) throw std::runtime_error("New local absolute QA directory required");
        for (const auto& part : root) if (part == L".." || part == L".") throw std::runtime_error("Dot components forbidden");
        for (fs::path ancestor = root.parent_path(); !ancestor.empty();) {
            DWORD attributes = GetFileAttributesW(ancestor.c_str());
            if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("Existing ordinary QA ancestors required");
            fs::path next = ancestor.parent_path(); if (next == ancestor) break; ancestor = next;
        }
        require(fs::create_directory(root), "Create exclusive QA directory"); rootCreated = true;
        Handle token; require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) != 0, "Parent token");
        DWORD size = 0; GetTokenInformation(token.value, TokenUser, nullptr, 0, &size); std::vector<unsigned char> user(size);
        require(GetTokenInformation(token.value, TokenUser, user.data(), size, &size) != 0, "Parent SID");
        PSID ownerSid = reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
        grant(root, ownerSid, FILE_ALL_ACCESS, true); const std::wstring owner = sidText(ownerSid);
        fs::create_directory(root / L"alice"); fs::create_directory(root / L"bob");
        wchar_t executable[32768]{}; require(GetModuleFileNameW(nullptr, executable, 32768) != 0, "Launcher path");
        fs::copy_file(fs::path(executable).parent_path() / L"windows-model-pipe-child.exe", root / L"child.exe");
        const std::wstring suffix = std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(GetTickCount64());
        alice.name = L"YuanZhou.PipeQA.A." + suffix; bob.name = L"YuanZhou.PipeQA.B." + suffix;
        for (auto* profile : {&alice, &bob}) {
            HRESULT result = CreateAppContainerProfile(profile->name.c_str(), L"Synthetic pipe QA", L"No model credentials", nullptr, 0, &profile->sid);
            if (FAILED(result)) throw std::runtime_error("Disposable AppContainer profile creation failed");
            grant(root, profile->sid, GENERIC_READ | GENERIC_EXECUTE, false);
            grant(root / L"child.exe", profile->sid, GENERIC_READ | GENERIC_EXECUTE, false);
        }
        grant(root / L"alice", alice.sid, FILE_ALL_ACCESS, true); labelLow(root / L"alice");
        grant(root / L"bob", bob.sid, FILE_ALL_ACCESS, true); labelLow(root / L"bob");
        wchar_t objectPath[2048]{}; ULONG objectPathLength = 0;
        require(GetAppContainerNamedObjectPath(nullptr, alice.sid, 2048, objectPath, &objectPathLength) != 0, "AppContainer object namespace");
        DWORD session = 0; require(ProcessIdToSessionId(GetCurrentProcessId(), &session) != 0, "Host session ID");
        const std::wstring name = L"\\\\.\\pipe\\Sessions\\" + std::to_wstring(session) + L"\\" + std::wstring(objectPath) + L"\\YuanZhou.ModelQA." + suffix;
        const std::wstring clientName = L"\\\\.\\pipe\\LOCAL\\YuanZhou.ModelQA." + suffix;
        const std::wstring namespaceDescription = std::wstring(objectPath);
        std::string namespaceAscii;
        for (wchar_t c : namespaceDescription) { if (c > 127) throw std::runtime_error("Unexpected non-ASCII object namespace"); namespaceAscii.push_back(static_cast<char>(c)); }
        writeText(root / L"object-namespace.txt", namespaceAscii);
        Handle narrow; narrow.value = makePipe(name, owner, alice.sid, false); require(narrow.value != INVALID_HANDLE_VALUE, "Create narrow broker pipe");
        authorizedRoundtrip(narrow.value, root, alice.sid, clientName, false, L"narrow-a.json");
        { Child denied; launch(denied, root, root / L"bob", bob.sid, L"denied", name, false, L"narrow-b.json"); require(denied.wait() == 0, "Other AppContainer not denied"); }
        { Child denied; launch(denied, root, root / L"alice", alice.sid, L"generic-denied", clientName, true, L"narrow-generic.json"); require(denied.wait() == 0, "Generic client unexpectedly fits narrow DACL"); }
        authorizedRoundtrip(narrow.value, root, alice.sid, clientName, false, L"narrow-reconnect.json");
        CloseHandle(narrow.value); narrow.value = nullptr;
        const std::wstring genericName = name + L".Generic";
        Handle genericPipe; genericPipe.value = makePipe(genericName, owner, alice.sid, true); require(genericPipe.value != INVALID_HANDLE_VALUE, "Create generic broker pipe");
        authorizedRoundtrip(genericPipe.value, root, alice.sid, clientName + L".Generic", true, L"generic-a.json");
        CloseHandle(genericPipe.value); genericPipe.value = nullptr;
        const std::wstring occupiedName = name + L".Occupied";
        { Child attacker; launch(attacker, root, root / L"alice", alice.sid, L"preoccupy", clientName + L".Occupied", false, L"preoccupy.json");
            for (int i = 0; i < 100 && !fs::exists(root / L"alice" / L"preoccupy-ready") && WaitForSingleObject(attacker.process.value, 0) == WAIT_TIMEOUT; ++i) Sleep(30);
            bool ready = fs::exists(root / L"alice" / L"preoccupy-ready");
            DWORD brokerError = ERROR_NOT_SUPPORTED;
            if (ready) { Handle broker; broker.value = makePipe(occupiedName, owner, alice.sid, false); brokerError = broker.value == INVALID_HANDLE_VALUE ? GetLastError() : 0; require(brokerError == ERROR_ACCESS_DENIED || brokerError == ERROR_PIPE_BUSY, "Preoccupied pipe did not fail closed"); }
            writeText(root / L"preoccupy-server.json", "{\"attackerCreated\":" + std::string(ready ? "true" : "false") + ",\"brokerFirstInstanceError\":" + std::to_string(brokerError) + "}");
        }
        passed = true;
    } catch (const std::exception& error) { failure = error.what(); std::cerr << failure << "\n"; }
    bool aliceCleaned = alice.clean(), bobCleaned = bob.clean();
    if (rootCreated) writeText(root / L"summary.json", std::string("{\"scope\":\"synthetic-native-appcontainer-named-pipe\",\"passed\":") +
        (passed ? "true" : "false") + ",\"aliceProfileCleaned\":" + (aliceCleaned ? "true" : "false") + ",\"bobProfileCleaned\":" +
        (bobCleaned ? "true" : "false") + ",\"networkCapabilities\":0,\"mutualPidVerified\":" + (passed ? "true" : "false") +
        ",\"clientAppContainerSidVerified\":" + (passed ? "true" : "false") + ",\"realModelVerified\":false,\"deployable\":false}");
    if (passed) std::cout << "WINDOWS_SYNTHETIC_MODEL_PIPE_OK\n";
    return passed && aliceCleaned && bobCleaned ? 0 : 1;
}
#endif
