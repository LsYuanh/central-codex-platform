// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Synthetic inherited-pipe fixture ONLY. This is NOT a Codex runtime or model.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>
static char input[4096];
static WCHAR homePath[32768], finalPath[32768];
static WCHAR globalPath[32768], canaryPath[32768], previousCwd[32768];
static DWORD createReadCanary(const WCHAR* path) {
    HANDLE file = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ,
        NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return GetLastError();
    DWORD written = 0, received = 0, result = 0; char content[2]; LARGE_INTEGER zero;
    zero.QuadPart = 0;
    if (!WriteFile(file, "P0", 2, &written, NULL)) result = GetLastError();
    else if (written != 2) result = ERROR_WRITE_FAULT;
    else if (!SetFilePointerEx(file, zero, NULL, FILE_BEGIN)) result = GetLastError();
    else if (!ReadFile(file, content, 2, &received, NULL)) result = GetLastError();
    else if (received != 2 || content[0] != 'P' || content[1] != '0') result = ERROR_INVALID_DATA;
    CloseHandle(file); return result;
}
static DWORD finalPathError(HANDLE directory, DWORD flags) {
    if (directory == INVALID_HANDLE_VALUE) return ERROR_INVALID_HANDLE;
    DWORD count = GetFinalPathNameByHandleW(directory, finalPath, 32768, flags);
    return count ? (count < 32768 ? ERROR_SUCCESS : ERROR_INSUFFICIENT_BUFFER) : GetLastError();
}
static BOOL contains(const char* value, const char* needle) {
    for (; *value; ++value) {
        DWORD i = 0;
        while (needle[i] && value[i] && needle[i] == value[i]) ++i;
        if (!needle[i]) return TRUE;
    }
    return FALSE;
}
static void reply(const char* value) {
    DWORD length = 0, written = 0;
    while (value[length]) ++length;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), value, length, &written, NULL) || written != length)
        ExitProcess(41);
}
int main(void) {
    // This handle is inheritable in the parent, but deliberately excluded from
    // the launch handle list. The numeric value is a synthetic canary only.
    WCHAR number[32]; ULONG_PTR canary = 0;
    DWORD length = GetEnvironmentVariableW(L"YUAN_QA_CANARY_HANDLE", number, 32);
    if (!length || length >= 32) ExitProcess(43);
    for (DWORD i = 0; i < length; ++i) {
        if (number[i] < L'0' || number[i] > L'9') ExitProcess(44);
        canary = canary * 10 + (number[i] - L'0');
    }
    char secret; DWORD leaked = 0;
    BOOL readable = FALSE, invalidHandleException = FALSE;
    DWORD canaryError = 0;
    // Strict handle checking can raise STATUS_INVALID_HANDLE instead of
    // returning Win32 error 6. Catch only that precise invalid-handle status.
    __try {
        readable = ReadFile((HANDLE)canary, &secret, 1, &leaked, NULL);
        canaryError = readable ? 0 : GetLastError();
    } __except (GetExceptionCode() == (DWORD)0xc0000008 ? EXCEPTION_EXECUTE_HANDLER : EXCEPTION_CONTINUE_SEARCH) {
        canaryError = ERROR_INVALID_HANDLE; invalidHandleException = TRUE;
    }
    if (readable || canaryError != ERROR_INVALID_HANDLE) {
        char diagnostic[] = "omitted handle read error: 0000000000\n";
        DWORD numberValue = canaryError;
        for (int i = 35; i >= 26; --i) { diagnostic[i] = '0' + (char)(numberValue % 10); numberValue /= 10; }
        DWORD written = 0;
        WriteFile(GetStdHandle(STD_ERROR_HANDLE), diagnostic, sizeof(diagnostic) - 1, &written, NULL);
        ExitProcess(45);
    }
    DWORD homeLength = GetEnvironmentVariableW(L"CODEX_HOME", homePath, 32768);
    if (!homeLength || homeLength >= 32768) ExitProcess(46);
    DWORD homeAttributes = GetFileAttributesW(homePath);
    DWORD metadataError = homeAttributes == INVALID_FILE_ATTRIBUTES ? GetLastError() : 0;
    HANDLE directory = CreateFileW(homePath, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    DWORD directoryOpenError = directory == INVALID_HANDLE_VALUE ? GetLastError() : 0;
    DWORD normalizedDos = finalPathError(directory, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    DWORD openedDos = finalPathError(directory, FILE_NAME_OPENED | VOLUME_NAME_DOS);
    DWORD normalizedNt = finalPathError(directory, FILE_NAME_NORMALIZED | VOLUME_NAME_NT);
    DWORD openedNt = finalPathError(directory, FILE_NAME_OPENED | VOLUME_NAME_NT);
    DWORD globalReopenError = ERROR_NOT_SUPPORTED, globalWriteReadError = ERROR_NOT_SUPPORTED;
    DWORD globalCwdError = ERROR_NOT_SUPPORTED, globalRelativeWriteReadError = ERROR_NOT_SUPPORTED;
    DWORD restoreCwdError = ERROR_NOT_SUPPORTED;
    BOOL globalSameFileId = FALSE;
    if (normalizedNt == 0 && finalPathError(directory, FILE_NAME_NORMALIZED | VOLUME_NAME_NT) == 0) {
        if (swprintf(globalPath, 32768, L"\\\\?\\GLOBALROOT%ls", finalPath) < 0) ExitProcess(47);
        HANDLE reopened = CreateFileW(globalPath, FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS, NULL);
        globalReopenError = reopened == INVALID_HANDLE_VALUE ? GetLastError() : 0;
        if (reopened != INVALID_HANDLE_VALUE) {
            BY_HANDLE_FILE_INFORMATION originalInfo, reopenedInfo;
            if (GetFileInformationByHandle(directory, &originalInfo) && GetFileInformationByHandle(reopened, &reopenedInfo))
                globalSameFileId = originalInfo.dwVolumeSerialNumber == reopenedInfo.dwVolumeSerialNumber &&
                    originalInfo.nFileIndexHigh == reopenedInfo.nFileIndexHigh && originalInfo.nFileIndexLow == reopenedInfo.nFileIndexLow;
            CloseHandle(reopened);
        }
        if (swprintf(canaryPath, 32768, L"%ls\\nt-write-canary", globalPath) < 0) ExitProcess(48);
        globalWriteReadError = createReadCanary(canaryPath);
        DWORD cwdLength = GetCurrentDirectoryW(32768, previousCwd);
        if (!cwdLength || cwdLength >= 32768) ExitProcess(49);
        globalCwdError = SetCurrentDirectoryW(globalPath) ? 0 : GetLastError();
        if (globalCwdError == 0) {
            globalRelativeWriteReadError = createReadCanary(L"nt-cwd-canary");
            restoreCwdError = SetCurrentDirectoryW(previousCwd) ? 0 : GetLastError();
        }
    }
    DWORD normalizedNone = finalPathError(directory, FILE_NAME_NORMALIZED | VOLUME_NAME_NONE);
    DWORD openedNone = finalPathError(directory, FILE_NAME_OPENED | VOLUME_NAME_NONE);
    DWORD normalizedGuid = finalPathError(directory, FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
    DWORD openedGuid = finalPathError(directory, FILE_NAME_OPENED | VOLUME_NAME_GUID);
    DWORD guidReopenError = ERROR_NOT_SUPPORTED, guidReopenedDos = ERROR_NOT_SUPPORTED;
    if (openedGuid == 0) {
        HANDLE guidDirectory = CreateFileW(finalPath, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
        guidReopenError = guidDirectory == INVALID_HANDLE_VALUE ? GetLastError() : 0;
        guidReopenedDos = finalPathError(guidDirectory, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        if (guidDirectory != INVALID_HANDLE_VALUE) CloseHandle(guidDirectory);
    }
    if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
    DWORD count = 0;
    for (;;) {
        char next; DWORD received = 0;
        if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), &next, 1, &received, NULL) || !received) ExitProcess(0);
        if (next != '\n') {
            if (count >= sizeof(input) - 1) ExitProcess(42);
            input[count++] = next; continue;
        }
        input[count] = 0; count = 0;
        if (contains(input, "p0-initialize")) {
            char response[2048];
            snprintf(response, sizeof(response), "{\"id\":\"p0-initialize\",\"result\":{\"userAgent\":\"SYNTHETIC_IPC_FIXTURE yuan-zhou-remote-workspace/1\",\"inheritedCanaryError\":6,\"inheritedCanaryException\":%s,\"canonicalizationDiagnostics\":{\"metadataError\":%lu,\"directoryOpenError\":%lu,\"normalizedDos\":%lu,\"openedDos\":%lu,\"normalizedNt\":%lu,\"openedNt\":%lu,\"normalizedNone\":%lu,\"openedNone\":%lu,\"normalizedGuid\":%lu,\"openedGuid\":%lu,\"guidReopenError\":%lu,\"guidReopenedDos\":%lu,\"ntGlobalrootReopenError\":%lu,\"ntGlobalrootSameFileId\":%s,\"ntGlobalrootWriteReadError\":%lu,\"ntGlobalrootCwdError\":%lu,\"ntGlobalrootRelativeWriteReadError\":%lu,\"restoreCwdError\":%lu}}}\n",
                invalidHandleException ? "\"0xc0000008\"" : "null", metadataError, directoryOpenError,
                normalizedDos, openedDos, normalizedNt, openedNt, normalizedNone, openedNone,
                normalizedGuid, openedGuid, guidReopenError, guidReopenedDos, globalReopenError,
                globalSameFileId ? "true" : "false", globalWriteReadError, globalCwdError, globalRelativeWriteReadError, restoreCwdError);
            reply(response);
        }
        else if (contains(input, "p0-command"))
            reply("{\"id\":\"p0-command\",\"error\":{\"code\":-32602,\"message\":\"REMOTE_WORKSPACE_UNSUPPORTED: command/exec\"}}\n");
        else if (contains(input, "p0-filesystem"))
            reply("{\"id\":\"p0-filesystem\",\"error\":{\"code\":-32602,\"message\":\"REMOTE_WORKSPACE_UNSUPPORTED: fs/readFile\"}}\n");
    }
}
