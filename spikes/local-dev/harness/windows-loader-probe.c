// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Loader diagnostic only: no CRT, userenv, networking, credentials or inference.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static WCHAR output[32768];
void probe_entry(void) {
    const WCHAR *line = GetCommandLineW(), *root = NULL;
    const WCHAR pattern[] = L" --child \"";
    for (const WCHAR *p = line; *p; ++p) {
        int i = 0;
        while (pattern[i] && p[i] && pattern[i] == p[i]) ++i;
        if (!pattern[i]) { root = p + i; break; }
    }
    if (!root) ExitProcess(30);
    DWORD count = 0;
    while (root[count] && root[count] != L'"' && count < 32000) {
        output[count] = root[count]; ++count;
    }
    if (root[count] != L'"') ExitProcess(31);
    const WCHAR suffix[] = L"\\alice\\loader-entered";
    for (DWORD i = 0; i < sizeof(suffix) / sizeof(WCHAR); ++i) output[count + i] = suffix[i];
    HANDLE file = CreateFileW(output, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) ExitProcess(32);
    DWORD written = 0;
    BOOL ok = WriteFile(file, "synthetic loader entry reached", 30, &written, NULL);
    CloseHandle(file);
    ExitProcess(ok && written == 30 ? 0 : 33);
}
