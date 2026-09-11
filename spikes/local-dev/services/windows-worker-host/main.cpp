// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Native Windows Worker host candidate. No production qualification is implied.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <aclapi.h>
#include <tlhelp32.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <cctype>
#include <cwctype>
#include <cstring>
#include <algorithm>
#include <atomic>
#include <array>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>
#include <vector>
#include "windows-model-pipe-bridge.hpp"
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "crypt32.lib")

namespace fs = std::filesystem;
namespace {
struct Failure { const char* code; };
void need(bool ok, const char* code) { if (!ok) throw Failure{code}; }
struct Handle {
    HANDLE h = nullptr;
    Handle() = default;
    explicit Handle(HANDLE v): h(v) {}
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    Handle(Handle&& o) noexcept: h(o.h) { o.h = nullptr; }
    Handle& operator=(Handle&& o) noexcept { if (this != &o) { close(); h=o.h; o.h=nullptr; } return *this; }
    ~Handle() { close(); }
    void close() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); h=nullptr; }
    explicit operator bool() const { return h && h != INVALID_HANDLE_VALUE; }
};
struct Local { void* p=nullptr; ~Local(){if(p)LocalFree(p);} };
struct Sid { PSID p=nullptr; ~Sid(){if(p)FreeSid(p);} };
std::wstring sidText(PSID sid) {
    LPWSTR text=nullptr; need(ConvertSidToStringSidW(sid,&text)!=0,"HOST_IDENTITY_INVALID");
    Local memory{text}; return text;
}
std::wstring ownerSid() {
    Handle token; need(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.h)!=0,"HOST_IDENTITY_INVALID");
    DWORD n=0; GetTokenInformation(token.h,TokenUser,nullptr,0,&n);
    std::vector<unsigned char> bytes(n);
    need(n && GetTokenInformation(token.h,TokenUser,bytes.data(),n,&n)!=0,"HOST_IDENTITY_INVALID");
    return sidText(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid);
}
std::wstring hex(const unsigned char* p,size_t n) {
    static const wchar_t* alphabet=L"0123456789abcdef"; std::wstring out;
    for(size_t i=0;i<n;i++){out.push_back(alphabet[p[i]>>4]);out.push_back(alphabet[p[i]&15]);} return out;
}
struct Hasher {
    BCRYPT_ALG_HANDLE algorithm=nullptr; BCRYPT_HASH_HANDLE state=nullptr;
    Hasher() { need(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)==0,"HOST_HASH_FAILED");
        if(BCryptCreateHash(algorithm,&state,nullptr,0,nullptr,0,0)!=0){BCryptCloseAlgorithmProvider(algorithm,0);algorithm=nullptr;throw Failure{"HOST_HASH_FAILED"};} }
    ~Hasher(){if(state)BCryptDestroyHash(state);if(algorithm)BCryptCloseAlgorithmProvider(algorithm,0);}
    void add(const void* p,ULONG n){need(BCryptHashData(state,(PUCHAR)p,n,0)==0,"HOST_HASH_FAILED");}
    std::wstring finish(){unsigned char out[32]{};need(BCryptFinishHash(state,out,32,0)==0,"HOST_HASH_FAILED");return hex(out,32);}
};
std::wstring fingerprint(const std::wstring& value) { Hasher h;h.add(value.data(),static_cast<ULONG>(value.size()*sizeof(wchar_t)));return h.finish(); }
std::wstring fileHash(HANDLE file) {
    LARGE_INTEGER zero{};need(SetFilePointerEx(file,zero,nullptr,FILE_BEGIN)!=0,"HOST_RUNTIME_INVALID");
    Hasher hash;std::array<unsigned char,65536> bytes{};DWORD count=0;unsigned long long total=0;
    do{need(ReadFile(file,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)!=0,"HOST_RUNTIME_INVALID");
        total+=count;need(total<=1024ull*1024*1024,"HOST_RUNTIME_INVALID");if(count)hash.add(bytes.data(),count);}while(count);
    need(total>0,"HOST_RUNTIME_INVALID");return hash.finish();
}
std::wstring finalPath(HANDLE file,DWORD volume=VOLUME_NAME_GUID) {
    std::wstring result(32768,L'\0');DWORD n=GetFinalPathNameByHandleW(file,result.data(),static_cast<DWORD>(result.size()),FILE_NAME_NORMALIZED|volume);
    need(n && n<result.size(),"HOST_PATH_UNSAFE");result.resize(n);return result;
}
void ordinary(HANDLE file,bool directory) {
    BY_HANDLE_FILE_INFORMATION info{};need(GetFileInformationByHandle(file,&info)!=0,"HOST_PATH_UNSAFE");
    need(!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT) &&
        !!(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)==directory && (directory||info.nNumberOfLinks==1),"HOST_PATH_UNSAFE");
}
std::wstring dosPath(HANDLE original,bool directory) {
    // Use an actual handle-derived DOS spelling for Windows/Rust startup APIs.
    // Never strip a device prefix or replace the volume name lexically.
    auto result=finalPath(original,VOLUME_NAME_DOS);
    Handle reopened(CreateFileW(result.c_str(),FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT|(directory?FILE_FLAG_BACKUP_SEMANTICS:0),nullptr));
    need(!!reopened,"HOST_PATH_UNSAFE");ordinary(reopened.h,directory);
    FILE_ID_INFO before{},after{};
    need(GetFileInformationByHandleEx(original,FileIdInfo,&before,sizeof(before))!=0 &&
        GetFileInformationByHandleEx(reopened.h,FileIdInfo,&after,sizeof(after))!=0 &&
        before.VolumeSerialNumber==after.VolumeSerialNumber && memcmp(&before.FileId,&after.FileId,sizeof(before.FileId))==0 &&
        finalPath(original)==finalPath(reopened.h),"HOST_PATH_UNSAFE");
    return result;
}
size_t rootLength(const std::wstring& raw) {
    if(raw.size()>=3 && iswalpha(raw[0]) && raw[1]==L':' && raw[2]==L'\\')return 3;
    if(raw.size()>=7 && raw.rfind(L"\\\\?\\",0)==0 && iswalpha(raw[4]) && raw[5]==L':' && raw[6]==L'\\')return 7;
    if(raw.rfind(L"\\\\?\\Volume{",0)==0){auto end=raw.find(L"}\\",11);need(end!=std::wstring::npos,"HOST_PATH_UNSAFE");return end+2;}
    throw Failure{"HOST_PATH_UNSAFE"};
}
fs::path pathArg(std::wstring raw) {
    need(!raw.empty() && raw.size()<30000,"HOST_PATH_UNSAFE");
    for(wchar_t c:raw)need(c>=32 && c!=L'"',"HOST_PATH_UNSAFE");
    std::replace(raw.begin(),raw.end(),L'/',L'\\');size_t offset=rootLength(raw);
    while(offset<raw.size()) {auto end=raw.find(L'\\',offset);if(end==std::wstring::npos)end=raw.size();const auto s=raw.substr(offset,end-offset);
        need(!s.empty() && s!=L"." && s!=L".." && s.find_first_of(L":*?<>|")==std::wstring::npos && s.back()!=L'.' && s.back()!=L' ',"HOST_PATH_UNSAFE");offset=end+1;}
    return fs::path(raw);
}
struct Descriptor {
    PSECURITY_DESCRIPTOR p=nullptr;
    explicit Descriptor(const std::wstring& sddl){need(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&p,nullptr)!=0,"HOST_ACL_FAILED");}
    ~Descriptor(){if(p)LocalFree(p);}
    SECURITY_ATTRIBUTES attributes(bool inherit=false){return {sizeof(SECURITY_ATTRIBUTES),p,inherit?TRUE:FALSE};}
};
std::wstring acl(const std::wstring& owner,const std::wstring& app,const char* kind) {
    const bool directory=std::string(kind)!="file" && std::string(kind)!="config" && std::string(kind)!="lock";
    std::wstring result=L"O:"+owner+L"D:P(A;"+(directory?L"OICI":L"")+L";FA;;;"+owner+L")";
    if(!app.empty()) {
        if(std::string(kind)=="writable") result+=L"(A;;0x1201bf;;;"+app+L")(A;OICIIO;0x1301bf;;;"+app+L")";
        else result+=L"(A;"+std::wstring(directory?L"OICI":L"")+L";"+(std::string(kind)=="config"?L"FR":L"FRFX")+L";;;"+app+L")";
    }
    if(std::string(kind)=="writable")result+=L"S:(ML;OICI;NW;;;LW)";
    return result;
}
void exactAcl(HANDLE file,Descriptor& expected) {
    PSID owner=nullptr;PACL actual=nullptr;PSECURITY_DESCRIPTOR raw=nullptr;
    need(GetSecurityInfo(file,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,nullptr,&actual,nullptr,&raw)==ERROR_SUCCESS,"HOST_ACL_UNSAFE");
    Local memory{raw};PSID wantedOwner=nullptr;BOOL ignored=FALSE,present=FALSE;PACL wanted=nullptr;
    SECURITY_DESCRIPTOR_CONTROL controls{};DWORD revision=0;
    need(GetSecurityDescriptorControl(raw,&controls,&revision)!=0 && (controls&SE_DACL_PROTECTED),"HOST_ACL_UNSAFE");
    need(GetSecurityDescriptorOwner(expected.p,&wantedOwner,&ignored)!=0 && EqualSid(owner,wantedOwner),"HOST_ACL_UNSAFE");
    need(GetSecurityDescriptorDacl(expected.p,&present,&wanted,&ignored)!=0 && present && actual && wanted && actual->AceCount==wanted->AceCount,"HOST_ACL_UNSAFE");
    for(DWORD i=0;i<actual->AceCount;i++){
        void* a=nullptr;void* b=nullptr;need(GetAce(actual,i,&a) && GetAce(wanted,i,&b),"HOST_ACL_UNSAFE");
        auto aa=static_cast<ACCESS_ALLOWED_ACE*>(a),bb=static_cast<ACCESS_ALLOWED_ACE*>(b);
        need(aa->Header.AceType==ACCESS_ALLOWED_ACE_TYPE && aa->Header.AceType==bb->Header.AceType &&
            aa->Header.AceFlags==bb->Header.AceFlags && aa->Mask==bb->Mask && EqualSid(&aa->SidStart,&bb->SidStart),"HOST_ACL_UNSAFE");
    }
}
Handle openFile(const fs::path& path,DWORD access=GENERIC_READ|READ_CONTROL) {
    Handle h(CreateFileW(path.c_str(),access,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    need(!!h,"HOST_PATH_UNSAFE");ordinary(h.h,false);return h;
}
std::vector<Handle> pinParents(const fs::path& path) {
    std::vector<Handle> pins;auto raw=path.wstring();size_t offset=rootLength(raw);std::wstring current=raw.substr(0,offset);
    auto open=[&](const fs::path& p){Handle h(CreateFileW(p.c_str(),FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
        need(!!h,"HOST_PATH_UNSAFE");ordinary(h.h,true);pins.push_back(std::move(h));};
    open(current);while(offset<raw.size()){auto end=raw.find(L'\\',offset);if(end==std::wstring::npos)end=raw.size();
        if(current.back()!=L'\\')current+=L'\\';current+=raw.substr(offset,end-offset);open(current);offset=end+1;}return pins;
}
struct Directory { fs::path path;std::vector<Handle> pins; };
Directory directory(const fs::path& path,Descriptor& expected,bool create) {
    auto parents=pinParents(path.parent_path());
    if(create){auto security=expected.attributes();if(!CreateDirectoryW(path.c_str(),&security))need(GetLastError()==ERROR_ALREADY_EXISTS,"HOST_DIRECTORY_FAILED");}
    Handle h(CreateFileW(path.c_str(),FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    need(!!h,"HOST_DIRECTORY_FAILED");ordinary(h.h,true);exactAcl(h.h,expected);
    auto physical=fs::path(finalPath(h.h));parents.push_back(std::move(h));return {physical,std::move(parents)};
}
Handle createFile(const fs::path& p,Descriptor& security,DWORD access=GENERIC_READ|GENERIC_WRITE) {
    auto sa=security.attributes();Handle h(CreateFileW(p.c_str(),access,0,&sa,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));need(!!h,"HOST_FILE_CREATE_FAILED");return h;
}
void writeAll(HANDLE target,const void* data,DWORD size) {
    DWORD offset=0;while(offset<size){DWORD count=0;need(WriteFile(target,static_cast<const char*>(data)+offset,size-offset,&count,nullptr)!=0 && count,"HOST_TRANSPORT_FAILED");offset+=count;}
}
void writeFinalReceipt(const std::string& receipt) {
    // No pumps or Worker processes remain. Keep every captured reference alive
    // until this writer joins; cancellation never detaches a stack-using thread.
    bool sent=false;
    std::thread writer([&]{try{writeAll(GetStdHandle(STD_OUTPUT_HANDLE),receipt.data(),static_cast<DWORD>(receipt.size()));sent=true;}catch(...){}});
    const ULONGLONG deadline=GetTickCount64()+5000;
    DWORD waited=WaitForSingleObject(writer.native_handle(),4000);
    while(waited!=WAIT_OBJECT_0){
        // Repeated cancellation covers the interval just before synchronous I/O.
        CancelSynchronousIo(writer.native_handle());
        waited=WaitForSingleObject(writer.native_handle(),10);
        if(waited!=WAIT_OBJECT_0 && GetTickCount64()>=deadline){
            // Do not free receipt/sent while a blocked thread can still use them.
            // The incomplete receipt cannot authorize slot reuse upstream.
            TerminateProcess(GetCurrentProcess(),127);std::terminate();
        }
    }
    writer.join();need(sent,"HOST_TRANSPORT_FAILED");
}
void readExact(HANDLE input,void* data,DWORD size) {
    DWORD offset=0;while(offset<size){DWORD count=0;need(ReadFile(input,static_cast<char*>(data)+offset,size-offset,&count,nullptr)!=0 && count,"HOST_BOOTSTRAP_INVALID");offset+=count;}
}
DWORD readU32(HANDLE input){unsigned char p[4]{};readExact(input,p,4);return DWORD(p[0])|(DWORD(p[1])<<8)|(DWORD(p[2])<<16)|(DWORD(p[3])<<24);}
struct Bootstrap {
    unsigned short port=0;std::string lease,ca;
    ~Bootstrap(){if(!lease.empty())SecureZeroMemory(lease.data(),lease.size());}
};
Bootstrap bootstrap() {
    HANDLE input=GetStdHandle(STD_INPUT_HANDLE);char magic[8]{};readExact(input,magic,8);need(std::string(magic,8)=="YZWH0001","HOST_BOOTSTRAP_INVALID");
    Bootstrap b;DWORD port=readU32(input);need(port && port<=65535,"HOST_BOOTSTRAP_INVALID");b.port=static_cast<unsigned short>(port);
    DWORD n=readU32(input);need(n>=32 && n<=256,"HOST_BOOTSTRAP_INVALID");b.lease.resize(n);readExact(input,b.lease.data(),n);
    for(unsigned char c:b.lease)need(isalnum(c)||c=='_'||c=='-',"HOST_BOOTSTRAP_INVALID");
    n=readU32(input);need(n>0 && n<=16384,"HOST_BOOTSTRAP_INVALID");b.ca.resize(n);readExact(input,b.ca.data(),n);
    for(unsigned char c:b.ca)need(c==10||c==13||(c>=32&&c<127),"HOST_BOOTSTRAP_INVALID");
    need(b.ca.rfind("-----BEGIN CERTIFICATE-----",0)==0 && b.ca.find("PRIVATE KEY")==std::string::npos,"HOST_BOOTSTRAP_INVALID");return b;
}
bool lowercaseHex(const std::wstring& value,size_t n){return value.size()==n && value.find_first_not_of(L"0123456789abcdef")==std::wstring::npos;}
struct Spec {fs::path root,runtime;std::wstring hash,user,instance,model;DWORD parent=0;};
Handle parentProcess(DWORD expected) {
    need(expected && expected!=GetCurrentProcessId(),"HOST_PARENT_INVALID");
    Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0));need(!!snapshot,"HOST_PARENT_INVALID");
    PROCESSENTRY32W item{};item.dwSize=sizeof(item);bool found=false;
    for(BOOL ok=Process32FirstW(snapshot.h,&item);ok;ok=Process32NextW(snapshot.h,&item))if(item.th32ProcessID==GetCurrentProcessId()){found=item.th32ParentProcessID==expected;break;}
    need(found,"HOST_PARENT_INVALID");Handle p(OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,expected));
    need(!!p && WaitForSingleObject(p.h,0)==WAIT_TIMEOUT,"HOST_PARENT_INVALID");
    FILETIME pc{},pe{},pk{},pu{},hc{},he{},hk{},hu{};
    need(GetProcessTimes(p.h,&pc,&pe,&pk,&pu) && GetProcessTimes(GetCurrentProcess(),&hc,&he,&hk,&hu) && CompareFileTime(&pc,&hc)<=0,"HOST_PARENT_INVALID");return p;
}
struct ParentWatch {
    Handle stop{CreateEventW(nullptr,TRUE,FALSE,nullptr)},ready{CreateEventW(nullptr,TRUE,FALSE,nullptr)};std::thread watcher;
    explicit ParentWatch(HANDLE parent){need(!!stop&&!!ready,"HOST_PARENT_INVALID");watcher=std::thread([this,parent]{HANDLE waits[]{parent,stop.h,ready.h};DWORD r=WaitForMultipleObjects(3,waits,FALSE,30000);
        if(r==WAIT_OBJECT_0+1)return;if(r==WAIT_OBJECT_0+2){HANDLE ongoing[]{parent,stop.h};r=WaitForMultipleObjects(2,ongoing,FALSE,INFINITE);if(r==WAIT_OBJECT_0+1)return;}
        // OS process teardown closes every non-inherited kill-on-close Job.
        TerminateProcess(GetCurrentProcess(),125);std::terminate();});}
    ~ParentWatch(){SetEvent(stop.h);if(watcher.joinable())watcher.join();}
};
struct Pump {
    Handle done{CreateEventW(nullptr,TRUE,FALSE,nullptr)};std::thread thread;std::atomic<bool> stopping{false},failed{false};
    Pump(HANDLE source,HANDLE target,std::string instance={}){need(!!done,"HOST_TRANSPORT_FAILED");thread=std::thread([this,source,target,instance]{char bytes[16384];DWORD n=0;
        try{while(!stopping.load()){
            if(!ReadFile(source,bytes,sizeof(bytes),&n,nullptr)||!n)break;
            if(!instance.empty()){
                DWORD length=0;need(CryptBinaryToStringA(reinterpret_cast<BYTE*>(bytes),n,CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,nullptr,&length)!=0,"HOST_TRANSPORT_FAILED");
                std::string encoded(length,'\0');need(CryptBinaryToStringA(reinterpret_cast<BYTE*>(bytes),n,CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,encoded.data(),&length)!=0,"HOST_TRANSPORT_FAILED");
                if(!encoded.empty()&&encoded.back()==0)encoded.pop_back();
                const std::string frame="{\"method\":\"host/data\",\"params\":{\"protocol\":\"windows-worker-host/v1\",\"instanceId\":\""+instance+"\",\"base64\":\""+encoded+"\"}}\n";
                writeAll(target,frame.data(),static_cast<DWORD>(frame.size()));
            }else if(target)writeAll(target,bytes,n);
        }}catch(...){if(!stopping.load())failed=true;}SetEvent(done.h);});}
    void stop(){stopping=true;if(!thread.joinable())return;ULONGLONG deadline=GetTickCount64()+5000;
        while(WaitForSingleObject(thread.native_handle(),0)==WAIT_TIMEOUT){CancelSynchronousIo(thread.native_handle());if(WaitForSingleObject(thread.native_handle(),20)==WAIT_OBJECT_0)break;
            if(GetTickCount64()>=deadline){TerminateProcess(GetCurrentProcess(),126);std::terminate();}}
        thread.join();}
    ~Pump(){stop();}
};
struct Pipes {
    Handle inputRead,inputWrite,outputRead,outputWrite,errorRead,errorWrite;
    Pipes(){SECURITY_ATTRIBUTES sa{sizeof(sa),nullptr,TRUE};
        need(CreatePipe(&inputRead.h,&inputWrite.h,&sa,65536) && CreatePipe(&outputRead.h,&outputWrite.h,&sa,65536) && CreatePipe(&errorRead.h,&errorWrite.h,&sa,65536),"HOST_TRANSPORT_FAILED");
        for(HANDLE h:{inputWrite.h,outputRead.h,errorRead.h})need(SetHandleInformation(h,HANDLE_FLAG_INHERIT,0)!=0,"HOST_TRANSPORT_FAILED");}
};
std::wstring widen(const std::string& value){return std::wstring(value.begin(),value.end());}
std::string narrow(const std::wstring& value){
    std::string out;out.reserve(value.size());
    for(wchar_t c:value){need(static_cast<unsigned long>(c)<=0x7f,"HOST_ARGUMENT_INVALID");out.push_back(static_cast<char>(c));}
    return out;
}
void installConfig(const Directory& home,Descriptor& security,const std::wstring& model,const std::wstring& instance) {
    const std::string marker="# Managed by Yuan Zhou Windows Worker Host v1\n";
    const fs::path config=home.path/L"config.toml";
    need(GetFileAttributesW((home.path/L"auth.json").c_str())==INVALID_FILE_ATTRIBUTES && GetLastError()==ERROR_FILE_NOT_FOUND,"HOST_CREDENTIAL_MIGRATION_REQUIRED");
    DWORD attributes=GetFileAttributesW(config.c_str());
    if(attributes!=INVALID_FILE_ATTRIBUTES){auto prior=openFile(config);exactAcl(prior.h,security);char bytes[128]{};DWORD count=0;
        need(ReadFile(prior.h,bytes,sizeof(bytes),&count,nullptr)!=0 && std::string(bytes,count).rfind(marker,0)==0,"HOST_CONFIG_MIGRATION_REQUIRED");}
    else need(GetLastError()==ERROR_FILE_NOT_FOUND,"HOST_CONFIG_MIGRATION_REQUIRED");
    const std::string content=marker+"model = \""+narrow(model)+"\"\nmodel_provider = \"yuan_broker\"\ncli_auth_credentials_store = \"file\"\n[model_providers.yuan_broker]\nname = \"Central model broker\"\nbase_url = \"https://model-broker.invalid/v1\"\nenv_key = \"CODEX_REMOTE_MODEL_LEASE\"\nwire_api = \"responses\"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\nsupports_websockets = false\n";
    const auto temporary=home.path/(L".host-config-"+instance);auto file=createFile(temporary,security);
    writeAll(file.h,content.data(),static_cast<DWORD>(content.size()));need(FlushFileBuffers(file.h)!=0,"HOST_CONFIG_FAILED");file.close();
    need(MoveFileExW(temporary.c_str(),config.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)!=0,"HOST_CONFIG_FAILED");
}
Handle cacheBinary(const fs::path& source,const Directory& bin,Descriptor& security,const std::wstring& expected,fs::path& executable) {
    auto sourceParents=pinParents(source.parent_path());auto input=openFile(source);need(fileHash(input.h)==expected,"HOST_RUNTIME_HASH_MISMATCH");
    executable=bin.path/(L"app-server-"+expected+L".exe");
    if(GetFileAttributesW(executable.c_str())==INVALID_FILE_ATTRIBUTES){need(GetLastError()==ERROR_FILE_NOT_FOUND,"HOST_RUNTIME_INVALID");
        auto output=createFile(executable,security);LARGE_INTEGER zero{};need(SetFilePointerEx(input.h,zero,nullptr,FILE_BEGIN)!=0,"HOST_RUNTIME_INVALID");
        char bytes[65536];DWORD count=0;do{need(ReadFile(input.h,bytes,sizeof(bytes),&count,nullptr)!=0,"HOST_RUNTIME_INVALID");if(count)writeAll(output.h,bytes,count);}while(count);
        need(FlushFileBuffers(output.h)!=0,"HOST_RUNTIME_INVALID");}
    auto actual=openFile(executable);exactAcl(actual.h,security);need(fileHash(actual.h)==expected,"HOST_RUNTIME_HASH_MISMATCH");return actual;
}
void verifyJobEmpty(HANDLE job,HANDLE process) {
    need(TerminateJobObject(job,0)!=0,"HOST_SHUTDOWN_INCOMPLETE");
    need(WaitForSingleObject(process,5000)==WAIT_OBJECT_0,"HOST_SHUTDOWN_INCOMPLETE");
    const ULONGLONG deadline=GetTickCount64()+5000;
    while(true){JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};need(QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&state,sizeof(state),nullptr)!=0,"HOST_SHUTDOWN_INCOMPLETE");
        if(state.ActiveProcesses==0)return;need(GetTickCount64()<deadline,"HOST_SHUTDOWN_INCOMPLETE");Sleep(10);}
}
void run(const Spec& spec) {
    auto parent=parentProcess(spec.parent);ParentWatch watchdog(parent.h);auto boot=bootstrap();
    const auto owner=ownerSid();Descriptor rootSecurity(acl(owner,L"","directory"));
    auto root=directory(spec.root,rootSecurity,true);
    const auto profileHash=fingerprint(root.path.wstring()+L"/"+spec.user);
    const auto profile=L"YuanZhou.Worker."+profileHash.substr(0,48);Sid sid;
    HRESULT status=CreateAppContainerProfile(profile.c_str(),L"Yuan Zhou isolated worker",L"Persistent per-user Worker identity",nullptr,0,&sid.p);
    if(status==HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS))status=DeriveAppContainerSidFromAppContainerName(profile.c_str(),&sid.p);
    need(SUCCEEDED(status) && sid.p && IsValidSid(sid.p),"HOST_PROFILE_FAILED");const auto app=sidText(sid.p);
    Descriptor baseSecurity(acl(owner,app,"directory")),writeSecurity(acl(owner,app,"writable")),binarySecurity(acl(owner,app,"file")),configSecurity(acl(owner,app,"config")),lockSecurity(acl(owner,L"","lock"));
    auto user=directory(root.path/spec.user,baseSecurity,true);
    auto lockAttributes=lockSecurity.attributes();Handle lock(CreateFileW((user.path/L"host.lock").c_str(),GENERIC_READ|GENERIC_WRITE|READ_CONTROL,0,&lockAttributes,OPEN_ALWAYS,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    need(!!lock,"HOST_USER_IN_USE");ordinary(lock.h,false);exactAcl(lock.h,lockSecurity);
    auto jobAttributes=lockSecurity.attributes();Handle job(CreateJobObjectW(&jobAttributes,(L"Local\\YuanZhou.Worker."+profileHash).c_str()));
    need(!!job && GetLastError()!=ERROR_ALREADY_EXISTS,"HOST_USER_IN_USE");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS;limits.BasicLimitInformation.ActiveProcessLimit=1;
    need(SetInformationJobObject(job.h,JobObjectExtendedLimitInformation,&limits,sizeof(limits))!=0,"HOST_JOB_FAILED");
    auto home=directory(user.path/L"home",writeSecurity,true),runtime=directory(user.path/L"runtime",writeSecurity,true),bin=directory(user.path/L"bin",baseSecurity,true);
    fs::path executable;auto binary=cacheBinary(spec.runtime,bin,binarySecurity,spec.hash,executable);
    installConfig(home,configSecurity,spec.model,spec.instance);
    const auto homeDos=dosPath(home.pins.back().h,true),runtimeDos=dosPath(runtime.pins.back().h,true),executableDos=dosPath(binary.h,false);
    Pipes pipes;HANDLE handles[]{pipes.inputRead.h,pipes.outputWrite.h,pipes.errorWrite.h};
    SIZE_T n=0;InitializeProcThreadAttributeList(nullptr,3,0,&n);std::vector<unsigned char> bytes(n);auto attributes=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(bytes.data());
    need(InitializeProcThreadAttributeList(attributes,3,0,&n)!=0,"HOST_LAUNCH_FAILED");
    struct AttributeCleanup {LPPROC_THREAD_ATTRIBUTE_LIST p;~AttributeCleanup(){DeleteProcThreadAttributeList(p);}} cleanup{attributes};
    SECURITY_CAPABILITIES capabilities{};capabilities.AppContainerSid=sid.p;
    need(UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&capabilities,sizeof(capabilities),nullptr,nullptr)!=0 &&
        UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles),nullptr,nullptr)!=0,"HOST_LAUNCH_FAILED");
    // Windows 10+ assigns the process to this Job inside CreateProcess. A parent
    // death can therefore never strand a created-but-not-yet-assigned child.
    // Unsupported/failed JOB_LIST is fatal; there is no post-create fallback.
    need(UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job.h,sizeof(job.h),nullptr,nullptr)!=0,"HOST_JOB_FAILED");
    GUID guid{};need(SUCCEEDED(CoCreateGuid(&guid)),"HOST_LAUNCH_FAILED");wchar_t guidText[40]{};need(StringFromGUID2(guid,guidText,40)>0,"HOST_LAUNCH_FAILED");std::wstring nonce;
    for(wchar_t c:std::wstring(guidText))if(c!=L'{'&&c!=L'}')nonce+=c;
    wchar_t windows[32768]{};need(GetWindowsDirectoryW(windows,32768)>0,"HOST_LAUNCH_FAILED");
    std::vector<std::wstring> variables{L"SystemRoot="+std::wstring(windows),L"WINDIR="+std::wstring(windows),L"SystemDrive="+std::wstring(windows,2),
        L"HOME="+homeDos,L"USERPROFILE="+homeDos,L"LOCALAPPDATA="+homeDos,L"APPDATA="+homeDos,
        L"TEMP="+runtimeDos,L"TMP="+runtimeDos,L"CODEX_HOME="+homeDos,L"CODEX_REMOTE_WORKER_DIR="+runtimeDos,
        L"CODEX_REMOTE_WORKSPACE=1",L"CODEX_EXEC_SERVER_URL=none",L"CODEX_REMOTE_AUTH_MODE=broker",L"CODEX_REFRESH_TOKEN_URL_OVERRIDE=disabled://broker-owned-auth",
        L"CODEX_REVOKE_TOKEN_URL_OVERRIDE=disabled://broker-owned-auth",L"RUST_LOG=error",L"CODEX_REMOTE_MODEL_PIPE="+yuan::worker::WindowsModelPipeBridge::clientPipeName(nonce),
        L"CODEX_REMOTE_MODEL_CA_PEM="+widen(boot.ca),L"CODEX_REMOTE_MODEL_LEASE="+widen(boot.lease)};
    std::sort(variables.begin(),variables.end(),[](const auto&a,const auto&b){return _wcsicmp(a.c_str(),b.c_str())<0;});std::wstring environment;
    for(const auto& v:variables){environment+=v;environment.push_back(0);}environment.push_back(0);
    STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=attributes;startup.StartupInfo.lpDesktop=const_cast<LPWSTR>(L"winsta0\\default");
    startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=handles[0];startup.StartupInfo.hStdOutput=handles[1];startup.StartupInfo.hStdError=handles[2];
    std::wstring command=L"\""+executableDos+L"\"";PROCESS_INFORMATION info{};
    BOOL launched=CreateProcessW(executableDos.c_str(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT,environment.data(),runtimeDos.c_str(),&startup.StartupInfo,&info);
    SecureZeroMemory(environment.data(),environment.size()*sizeof(wchar_t));for(auto& v:variables)SecureZeroMemory(v.data(),v.size()*sizeof(wchar_t));
    need(launched!=0,"HOST_LAUNCH_FAILED");Handle process(info.hProcess),thread(info.hThread);
    BOOL inJob=FALSE;need(IsProcessInJob(process.h,job.h,&inJob)!=0 && inJob,"HOST_JOB_FAILED");
    yuan::worker::WindowsModelPipeBridge bridge(sid.p,boot.port,info.dwProcessId,nonce,[h=job.h](std::string){TerminateJobObject(h,123);});bridge.start();
    need(ResumeThread(thread.h)!=static_cast<DWORD>(-1),"HOST_LAUNCH_FAILED");
    pipes.inputRead.close();pipes.outputWrite.close();pipes.errorWrite.close();
    const std::string ready="{\"method\":\"host/ready\",\"params\":{\"protocol\":\"windows-worker-host/v1\",\"instanceId\":\""+narrow(spec.instance)+"\",\"pid\":"+std::to_string(info.dwProcessId)+",\"userKey\":\""+narrow(spec.user)+"\"}}\n";
    writeAll(GetStdHandle(STD_OUTPUT_HANDLE),ready.data(),static_cast<DWORD>(ready.size()));SetEvent(watchdog.ready.h);
    Pump input(GetStdHandle(STD_INPUT_HANDLE),pipes.inputWrite.h),output(pipes.outputRead.h,GetStdHandle(STD_OUTPUT_HANDLE),narrow(spec.instance)),diagnostic(pipes.errorRead.h,nullptr);
    HANDLE waits[]{process.h,input.done.h,output.done.h};DWORD waited=WaitForMultipleObjects(3,waits,FALSE,INFINITE);
    need(waited!=WAIT_FAILED,"HOST_TRANSPORT_FAILED");
    // stdout may close immediately before the process handle becomes signalled.
    // Capture only an observed natural exit, never our later Job termination.
    const bool naturalExit=WaitForSingleObject(process.h,waited==WAIT_OBJECT_0+2?100:0)==WAIT_OBJECT_0;
    DWORD runtimeExit=0;if(naturalExit)need(GetExitCodeProcess(process.h,&runtimeExit)!=0,"HOST_TRANSPORT_FAILED");
    verifyJobEmpty(job.h,process.h);input.stop();
    need(WaitForSingleObject(output.done.h,5000)==WAIT_OBJECT_0,"HOST_TRANSPORT_FAILED");
    output.stop();diagnostic.stop();bridge.stop();job.close();
    need(!bridge.failed(),"HOST_MODEL_PIPE_FAILED");
    if(naturalExit){const char* alphabet="0123456789ABCDEF";std::string code="HOST_RUNTIME_EXIT_";
        for(int shift=28;shift>=0;shift-=4)code.push_back(alphabet[(runtimeExit>>shift)&15]);code.push_back('\n');
        writeAll(GetStdHandle(STD_ERROR_HANDLE),code.data(),static_cast<DWORD>(code.size()));}
    const std::string closed="{\"method\":\"host/closed\",\"params\":{\"protocol\":\"windows-worker-host/v1\",\"instanceId\":\""+narrow(spec.instance)+"\",\"jobCloseVerified\":true}}\n";
    // A stalled/broken controller output must not hold the user lock indefinitely.
    writeFinalReceipt(closed);
}
} // namespace

int wmain(int argc,wchar_t** argv) {
    try {
        need(argc==15,"HOST_ARGUMENT_INVALID");
        const wchar_t* names[]{L"--root",L"--runtime",L"--sha256",L"--user-key",L"--instance",L"--model",L"--parent-pid"};
        for(int i=0;i<7;i++)need(std::wstring(argv[1+i*2])==names[i],"HOST_ARGUMENT_INVALID");
        Spec spec{pathArg(argv[2]),pathArg(argv[4]),argv[6],argv[8],argv[10],argv[12],0};
        need(lowercaseHex(spec.hash,64)&&lowercaseHex(spec.user,64)&&lowercaseHex(spec.instance,32),"HOST_ARGUMENT_INVALID");
        need(!spec.model.empty()&&spec.model.size()<=101 && iswalnum(spec.model[0]) && spec.model.find_first_not_of(L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")==std::wstring::npos,"HOST_ARGUMENT_INVALID");
        std::wstring pid=argv[14];need(!pid.empty()&&pid.size()<=10&&pid.find_first_not_of(L"0123456789")==std::wstring::npos,"HOST_PARENT_INVALID");
        auto parsed=std::stoull(pid);need(parsed>0&&parsed<=MAXDWORD,"HOST_PARENT_INVALID");spec.parent=static_cast<DWORD>(parsed);
        run(spec);return 0;
    } catch(const Failure& e){DWORD written=0;WriteFile(GetStdHandle(STD_ERROR_HANDLE),e.code,static_cast<DWORD>(strlen(e.code)),&written,nullptr);WriteFile(GetStdHandle(STD_ERROR_HANDLE),"\n",1,&written,nullptr);return 1;}
      catch(...){const char* code="HOST_INTERNAL_ERROR\n";DWORD written=0;WriteFile(GetStdHandle(STD_ERROR_HANDLE),code,static_cast<DWORD>(strlen(code)),&written,nullptr);return 2;}
}
