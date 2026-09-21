// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// QA only: one explicitly supplied numeric TCP echo endpoint, disposable AppContainer.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <aclapi.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include <algorithm>
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")
namespace fs = std::filesystem;
struct Handle { HANDLE value = nullptr; ~Handle(){if(value && value != INVALID_HANDLE_VALUE)CloseHandle(value);} };
struct Socket { SOCKET value = INVALID_SOCKET; ~Socket(){if(value != INVALID_SOCKET)closesocket(value);} };
static void check(bool ok, const char* stage){if(!ok)throw std::runtime_error(std::string(stage)+":"+std::to_string(GetLastError()));}
static void write(const fs::path& path,const std::string& value){std::ofstream out(path);out<<value;out.close();if(!out)throw std::runtime_error("QA_RESULT_WRITE_FAILED");}
static std::wstring quote(const std::wstring& value){if(value.find_first_of(L"\"\r\n")!=std::wstring::npos)throw std::runtime_error("QA_ARGUMENT_INVALID");return L"\""+value+L"\"";}
static void grant(const fs::path& path,PSID sid,DWORD access,bool inherit){
    PACL oldAcl=nullptr,newAcl=nullptr;PSECURITY_DESCRIPTOR descriptor=nullptr;
    DWORD error=GetNamedSecurityInfoW(path.c_str(),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,&oldAcl,nullptr,&descriptor);
    if(error)throw std::runtime_error("QA_ACL_READ_FAILED");
    EXPLICIT_ACCESSW entry{};entry.grfAccessPermissions=access;entry.grfAccessMode=GRANT_ACCESS;
    entry.grfInheritance=inherit?SUB_CONTAINERS_AND_OBJECTS_INHERIT:NO_INHERITANCE;
    entry.Trustee.TrusteeForm=TRUSTEE_IS_SID;entry.Trustee.ptstrName=static_cast<LPWSTR>(sid);
    error=SetEntriesInAclW(1,&entry,oldAcl,&newAcl);
    if(!error)error=SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,newAcl,nullptr);
    LocalFree(newAcl);LocalFree(descriptor);if(error)throw std::runtime_error("QA_ACL_GRANT_FAILED");
}
static void labelLow(const fs::path& path){
    PSECURITY_DESCRIPTOR descriptor=nullptr;PACL acl=nullptr;BOOL present=FALSE,defaulted=FALSE;
    check(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;OICI;NW;;;LW)",SDDL_REVISION_1,&descriptor,nullptr)!=0,"QA_LOW_LABEL");
    check(GetSecurityDescriptorSacl(descriptor,&present,&acl,&defaulted)!=0,"QA_LOW_SACL");
    DWORD error=SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()),SE_FILE_OBJECT,LABEL_SECURITY_INFORMATION,nullptr,nullptr,nullptr,acl);
    LocalFree(descriptor);if(error)throw std::runtime_error("QA_LOW_LABEL_FAILED");
}
struct Target {sockaddr_storage address{};int length=0;int family=0;};
static Target target(const std::wstring& ip,const std::wstring& port){
    if(port.empty()||port.find_first_not_of(L"0123456789")!=std::wstring::npos)throw std::runtime_error("QA_PORT_INVALID");
    unsigned long number=std::stoul(port);if(!number||number>65535)throw std::runtime_error("QA_PORT_INVALID");
    Target result;
    auto v4=reinterpret_cast<sockaddr_in*>(&result.address);auto v6=reinterpret_cast<sockaddr_in6*>(&result.address);
    if(InetPtonW(AF_INET,ip.c_str(),&v4->sin_addr)==1){result.family=AF_INET;result.length=sizeof(*v4);v4->sin_family=AF_INET;v4->sin_port=htons(static_cast<u_short>(number));}
    else if(InetPtonW(AF_INET6,ip.c_str(),&v6->sin6_addr)==1){result.family=AF_INET6;result.length=sizeof(*v6);v6->sin6_family=AF_INET6;v6->sin6_port=htons(static_cast<u_short>(number));}
    else throw std::runtime_error("QA_NUMERIC_IP_REQUIRED");
    return result;
}
static bool probe(const fs::path& output,const std::wstring& ip,const Target& endpoint,bool child){
    Handle token;check(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.value)!=0,"QA_TOKEN_OPEN");
    DWORD appContainer=0,size=0;
    check(GetTokenInformation(token.value,TokenIsAppContainer,&appContainer,sizeof(appContainer),&size)!=0,"QA_TOKEN_CONTAINER");
    DWORD bytes=0;GetTokenInformation(token.value,TokenCapabilities,nullptr,0,&bytes);std::vector<unsigned char> capabilities(bytes);
    check(GetTokenInformation(token.value,TokenCapabilities,capabilities.data(),bytes,&bytes)!=0,"QA_TOKEN_CAPABILITIES");
    DWORD count=reinterpret_cast<TOKEN_GROUPS*>(capabilities.data())->GroupCount;
    if(child&&(appContainer!=1||count!=0))throw std::runtime_error("QA_ISOLATION_TOKEN_MISMATCH");
    Socket socket;socket.value=::socket(endpoint.family,SOCK_STREAM,IPPROTO_TCP);check(socket.value!=INVALID_SOCKET,"QA_SOCKET");
    u_long mode=1;check(ioctlsocket(socket.value,FIONBIO,&mode)==0,"QA_SOCKET_MODE");
    const ULONGLONG start=GetTickCount64();
    int connected=connect(socket.value,reinterpret_cast<const sockaddr*>(&endpoint.address),endpoint.length);
    const int initial=connected==0?0:WSAGetLastError();int finalError=initial;
    if(initial==WSAEWOULDBLOCK){
        fd_set writable,failed;FD_ZERO(&writable);FD_ZERO(&failed);FD_SET(socket.value,&writable);FD_SET(socket.value,&failed);
        timeval timeout{5,0};int selected=select(0,nullptr,&writable,&failed,&timeout);
        if(selected==0)finalError=WSAETIMEDOUT;
        else if(selected==SOCKET_ERROR)finalError=WSAGetLastError();
        else {int length=sizeof(finalError);if(getsockopt(socket.value,SOL_SOCKET,SO_ERROR,reinterpret_cast<char*>(&finalError),&length)==SOCKET_ERROR)finalError=WSAGetLastError();}
    }
    const ULONGLONG connectMs=GetTickCount64()-start;
    bool echoed=false;int echoError=0;
    if(finalError==0){
        mode=0;check(ioctlsocket(socket.value,FIONBIO,&mode)==0,"QA_SOCKET_BLOCKING");
        DWORD timeout=2000;check(setsockopt(socket.value,SOL_SOCKET,SO_SNDTIMEO,reinterpret_cast<char*>(&timeout),sizeof(timeout))==0,"QA_SEND_TIMEOUT");
        check(setsockopt(socket.value,SOL_SOCKET,SO_RCVTIMEO,reinterpret_cast<char*>(&timeout),sizeof(timeout))==0,"QA_RECV_TIMEOUT");
        const std::string message=child?"APPCONTAINER_NETWORK_QA":"HOST_BASELINE_NETWORK_QA";
        int sent=send(socket.value,message.data(),static_cast<int>(message.size()),0);
        if(sent!=static_cast<int>(message.size()))echoError=sent==SOCKET_ERROR?WSAGetLastError():ERROR_WRITE_FAULT;
        else {std::string reply(message.size(),'\0');size_t offset=0;
            while(offset<reply.size()){int got=recv(socket.value,reply.data()+offset,static_cast<int>(reply.size()-offset),0);if(got<=0){echoError=got==SOCKET_ERROR?WSAGetLastError():ERROR_HANDLE_EOF;break;}offset+=got;}
            echoed=reply==message;
        }
    }
    // Both read-only APIs execute in the same security context as connect.
    HMODULE library=LoadLibraryExW(L"Firewallapi.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);
    DWORD loadError=library?0:GetLastError(),infoError=ERROR_PROC_NOT_FOUND,netIsoType=0xffffffff,legacyResult=0xffffffff;
    if(library){
        using Info=DWORD(WINAPI*)(LPCWSTR,DWORD*);using Legacy=DWORD(WINAPI*)(LPCWSTR);
        auto info=reinterpret_cast<Info>(GetProcAddress(library,"NetworkIsolationDiagnoseConnectFailureAndGetInfo"));
        auto legacy=reinterpret_cast<Legacy>(GetProcAddress(library,"NetworkIsolationDiagnoseConnectFailure"));
        if(info)infoError=info(ip.c_str(),&netIsoType);
        if(legacy)legacyResult=legacy(ip.c_str());
        FreeLibrary(library);
    }
    write(output,"{\"appContainer\":"+std::to_string(appContainer)+",\"capabilityCount\":"+std::to_string(count)+
        ",\"addressFamily\":"+std::to_string(endpoint.family)+",\"initialConnectError\":"+std::to_string(initial)+
        ",\"finalConnectError\":"+std::to_string(finalError)+",\"connectElapsedMs\":"+std::to_string(connectMs)+
        ",\"echoMatched\":"+(echoed?"true":"false")+",\"echoError\":"+std::to_string(echoError)+
        ",\"diagnosticLoadError\":"+std::to_string(loadError)+",\"diagnosticApiError\":"+std::to_string(infoError)+
        ",\"netIsoErrorType\":"+std::to_string(netIsoType)+",\"legacyDiagnosticResult\":"+std::to_string(legacyResult)+"}");
    return echoed;
}
int wmain(int argc,wchar_t** argv){
    if(argc!=4&&argc!=5)return 2;
    const bool child=argc==5&&std::wstring(argv[1])==L"--child";
    const fs::path root=argv[child?2:1];const std::wstring ip=argv[child?3:2],port=argv[child?4:3];
    WSADATA data{};if(WSAStartup(MAKEWORD(2,2),&data))return 3;
    if(child){try{probe(root/L"own"/L"child.json",ip,target(ip,port),true);WSACleanup();return 0;}catch(...){WSACleanup();return 4;}}
    PSID sid=nullptr;bool created=false,rootCreated=false,cleaned=false,completed=false,workerExited=false;DWORD exitCode=0;
    std::wstring profile=L"YuanZhou.NetworkQA."+std::to_wstring(GetCurrentProcessId())+L"."+std::to_wstring(GetTickCount64());
    std::string failure;
    try{
        const auto endpoint=target(ip,port);
        if(!root.is_absolute()||root.wstring().rfind(L"\\\\",0)==0||fs::exists(root))throw std::runtime_error("QA_NEW_LOCAL_ROOT_REQUIRED");
        for(const auto& component:root)if(component==L"."||component==L"..")throw std::runtime_error("QA_DOT_COMPONENT");
        for(auto ancestor=root.parent_path();!ancestor.empty();){
            DWORD attrs=GetFileAttributesW(ancestor.c_str());if(attrs==INVALID_FILE_ATTRIBUTES||!(attrs&FILE_ATTRIBUTE_DIRECTORY)||(attrs&FILE_ATTRIBUTE_REPARSE_POINT))throw std::runtime_error("QA_ORDINARY_PARENT_REQUIRED");
            auto next=ancestor.parent_path();if(next==ancestor)break;ancestor=next;
        }
        check(fs::create_directory(root),"QA_CREATE_ROOT");rootCreated=true;
        Handle owner;check(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&owner.value)!=0,"QA_OWNER_TOKEN");
        DWORD size=0;GetTokenInformation(owner.value,TokenUser,nullptr,0,&size);std::vector<unsigned char> user(size);
        check(GetTokenInformation(owner.value,TokenUser,user.data(),size,&size)!=0,"QA_OWNER_SID");
        grant(root,reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid,FILE_ALL_ACCESS,true);
        check(fs::create_directory(root/L"own"),"QA_CREATE_OWN");
        if(!probe(root/L"host.json",ip,endpoint,false))throw std::runtime_error("QA_HOST_ECHO_BASELINE_FAILED");
        wchar_t executable[32768]{};check(GetModuleFileNameW(nullptr,executable,32768)!=0,"QA_SELF_PATH");
        check(fs::copy_file(executable,root/L"probe.exe"),"QA_COPY_SELF");
        HRESULT hr=CreateAppContainerProfile(profile.c_str(),L"Network QA",L"Disposable numeric TCP test",nullptr,0,&sid);
        if(FAILED(hr))throw std::runtime_error("QA_PROFILE_CREATE:"+std::to_string(static_cast<unsigned long>(hr)));created=true;
        grant(root,sid,GENERIC_READ|GENERIC_EXECUTE,false);grant(root/L"probe.exe",sid,GENERIC_READ|GENERIC_EXECUTE,false);
        grant(root/L"own",sid,FILE_ALL_ACCESS,true);labelLow(root/L"own");
        Handle job,process,thread;
        struct Cleanup{Handle& job;Handle& process;~Cleanup(){if(job.value){CloseHandle(job.value);job.value=nullptr;}if(process.value&&WaitForSingleObject(process.value,5000)!=WAIT_OBJECT_0)std::terminate();}} cleanup{job,process};
        job.value=CreateJobObjectW(nullptr,nullptr);check(job.value!=nullptr,"QA_JOB_CREATE");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.ActiveProcessLimit=1;check(SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits))!=0,"QA_JOB_LIMIT");
        SIZE_T attributeSize=0;InitializeProcThreadAttributeList(nullptr,1,0,&attributeSize);std::vector<unsigned char> storage(attributeSize);
        auto attributes=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());check(InitializeProcThreadAttributeList(attributes,1,0,&attributeSize)!=0,"QA_ATTRIBUTES");
        struct AttributeGuard{LPPROC_THREAD_ATTRIBUTE_LIST value;~AttributeGuard(){DeleteProcThreadAttributeList(value);}} guard{attributes};
        SECURITY_CAPABILITIES capabilities{};capabilities.AppContainerSid=sid;
        check(UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&capabilities,sizeof(capabilities),nullptr,nullptr)!=0,"QA_CONTAINER_ATTRIBUTE");
        STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=attributes;
        wchar_t desktop[]=L"winsta0\\default";startup.StartupInfo.lpDesktop=desktop;
        wchar_t windows[MAX_PATH]{};check(GetWindowsDirectoryW(windows,MAX_PATH)!=0,"QA_WINDOWS_DIRECTORY");
        std::vector<std::wstring> variables{L"SystemRoot="+std::wstring(windows),L"SystemDrive="+std::wstring(windows).substr(0,2),
            L"WINDIR="+std::wstring(windows),L"USERPROFILE="+(root/L"own").wstring(),L"LOCALAPPDATA="+(root/L"own").wstring(),
            L"APPDATA="+(root/L"own").wstring(),L"TEMP="+(root/L"own").wstring(),L"TMP="+(root/L"own").wstring()};
        std::sort(variables.begin(),variables.end(),[](const auto& a,const auto& b){return _wcsicmp(a.c_str(),b.c_str())<0;});
        std::wstring environment;for(const auto& value:variables){environment+=value;environment.push_back(0);}environment.push_back(0);
        std::wstring command=quote((root/L"probe.exe").wstring())+L" --child "+quote(root.wstring())+L" "+quote(ip)+L" "+quote(port);
        PROCESS_INFORMATION info{};
        check(CreateProcessW((root/L"probe.exe").c_str(),command.data(),nullptr,nullptr,FALSE,
            EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT,environment.data(),(root/L"own").c_str(),&startup.StartupInfo,&info)!=0,"QA_CONTAINER_LAUNCH");
        process.value=info.hProcess;thread.value=info.hThread;
        if(!AssignProcessToJobObject(job.value,process.value)){TerminateProcess(process.value,11);check(WaitForSingleObject(process.value,5000)==WAIT_OBJECT_0,"QA_UNASSIGNED_EXIT");throw std::runtime_error("QA_JOB_ASSIGN_FAILED");}
        check(ResumeThread(thread.value)!=static_cast<DWORD>(-1),"QA_RESUME");
        check(WaitForSingleObject(process.value,25000)==WAIT_OBJECT_0,"QA_CHILD_DEADLINE");workerExited=true;
        check(GetExitCodeProcess(process.value,&exitCode)!=0,"QA_CHILD_EXIT_CODE");check(exitCode==0,"QA_CHILD_FAILED");
        completed=true;
    }catch(const std::exception& error){failure=error.what();}
    if(created)cleaned=SUCCEEDED(DeleteAppContainerProfile(profile.c_str()));if(sid)FreeSid(sid);WSACleanup();
    if(rootCreated)write(root/L"summary.json","{\"scope\":\"numeric-tcp-network-observation\",\"completed\":"+std::string(completed?"true":"false")+
        ",\"profileCleaned\":"+(cleaned?"true":"false")+",\"workerExitObserved\":"+(workerExited?"true":"false")+
        ",\"workerExitCode\":"+std::to_string(exitCode)+",\"networkQualified\":false,\"failure\":\""+failure+"\"}");
    if(!completed||!cleaned){std::cerr<<failure<<"\n";return 1;}
    std::cout<<"WINDOWS_NETWORK_OBSERVATION_COMPLETE\n";return 0;
}
