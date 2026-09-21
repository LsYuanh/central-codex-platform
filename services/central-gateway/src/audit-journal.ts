// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { openSync, closeSync, fsyncSync, writeSync, readFileSync, readdirSync, mkdirSync, lstatSync, fstatSync, constants } from "node:fs";
import { join } from "node:path";
export type AuditRecord = {id:string;at:string;action:string;status:string;userId?:string;deviceId?:string;requestId?:string;errorCode?:string};
const fields=["id","at","action","status","userId","deviceId","requestId","errorCode"] as const;
const required=["id","at","action","status"] as const;
function sanitize(input:AuditRecord):AuditRecord {
  if(!input||typeof input!=="object"||required.some(k=>typeof input[k]!=="string"||!input[k]))throw Error("AUDIT_RECORD_INVALID");
  const value={} as AuditRecord;
  for(const field of fields)if(typeof input[field]==="string")value[field]=input[field]!.replace(/[\x00-\x1f\x7f]/g," ").slice(0,256);
  if(!/^[a-z][a-z0-9_.-]{0,127}$/.test(value.action))value.action="audit.unknown";
  if(!/^[a-z][a-z0-9_]{0,31}$/.test(value.status))value.status="unknown";
  if(value.errorCode!==undefined&&!/^[A-Z][A-Z0-9_]{0,127}$/.test(value.errorCode))value.errorCode="AUDIT_ERROR_REDACTED";
  return value;
}
/** One gateway owns this directory; this is not a multi-process storage protocol.
 * Bounded segments and a bounded recent cache; fsync precedes acknowledgement.
 * Any uncertain write poisons this instance until restart/repair, without replay.
 */
export class AuditJournal {
  private segment=1;
  private size=0;
  private exists=false;
  private failed=false;
  readonly recent:AuditRecord[]=[];
  constructor(private directory:string,private maxBytes=4*1024*1024){
    if(!Number.isSafeInteger(maxBytes)||maxBytes<256)throw Error("AUDIT_SEGMENT_SIZE_INVALID");
    mkdirSync(directory,{recursive:true,mode:0o700});
    this.checkDirectory();
    const files=readdirSync(directory).filter(n=>/^audit-\d{8}\.jsonl$/.test(n)).sort();
    for(const [index,name] of files.entries()){
      if(name!==`audit-${String(index+1).padStart(8,"0")}.jsonl`)throw Error("AUDIT_SEGMENT_MISSING");
      const path=join(directory,name),stat=lstatSync(path);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes||(stat.size===0&&index<files.length-1))throw Error("AUDIT_SEGMENT_INVALID");
      let raw:string;
      try{raw=new TextDecoder("utf-8",{fatal:true}).decode(readFileSync(path));}catch{throw Error("AUDIT_RECORD_INVALID: invalid UTF-8");}
      if(raw&&!raw.endsWith("\n"))throw Error("AUDIT_TRUNCATED: repair required; history was not reset");
      for(const line of raw?raw.slice(0,-1).split("\n"):[]){
        let value:AuditRecord;
        try{
          value=JSON.parse(line) as AuditRecord;
          const clean=sanitize(value);
          if(Object.keys(value).some(k=>!fields.includes(k as typeof fields[number]))||fields.some(k=>value[k]!==clean[k]))throw Error();
        }catch{throw Error("AUDIT_RECORD_INVALID: repair required; history was not reset");}
        this.remember(value);
      }
      this.segment=index+1;this.size=stat.size;this.exists=true;
    }
  }
  private checkDirectory(){const stat=lstatSync(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error("AUDIT_PATH_UNSAFE");}
  private remember(value:AuditRecord){this.recent.push(Object.freeze({...value}));if(this.recent.length>1000)this.recent.splice(0,this.recent.length-1000);}
  append(input:AuditRecord):AuditRecord {
    if(this.failed)throw Error("AUDIT_STORAGE_UNAVAILABLE");
    try{
      const value=sanitize(input),line=Buffer.from(JSON.stringify(value)+"\n");
      if(line.length>this.maxBytes)throw Error("AUDIT_RECORD_TOO_LARGE");
      this.checkDirectory();
      // Detect a stale reopened instance or changed file before appending. The
      // deployment must still enforce one writer: this check is not a lock.
      if(this.exists){
        const stat=lstatSync(join(this.directory,`audit-${String(this.segment).padStart(8,"0")}.jsonl`));
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==this.size)throw Error("AUDIT_SEGMENT_CHANGED");
      }
      const rotate=this.size>0&&this.size+line.length>this.maxBytes;
      const segment=this.segment+(rotate?1:0),exists=this.exists&&!rotate;
      if(segment>99999999)throw Error("AUDIT_CAPACITY");
      const path=join(this.directory,`audit-${String(segment).padStart(8,"0")}.jsonl`);
      const fd=openSync(path,constants.O_WRONLY|constants.O_APPEND|(exists?0:constants.O_CREAT|constants.O_EXCL)|(constants.O_NOFOLLOW??0),0o600);
      try{
        const stat=fstatSync(fd);
        if(!stat.isFile()||stat.size!==(exists?this.size:0))throw Error("AUDIT_SEGMENT_CHANGED");
        let written=0;
        while(written<line.length){const count=writeSync(fd,line,written);if(count<=0)throw Error("AUDIT_WRITE_INCOMPLETE");written+=count;}
        fsyncSync(fd);
      }finally{closeSync(fd);}
      // macOS/Linux need the new directory entry flushed as well as its contents.
      // Node does not support directory fsync on Windows.
      if(!exists&&process.platform!=="win32"){
        const parent=openSync(this.directory,constants.O_RDONLY);
        try{fsyncSync(parent);}finally{closeSync(parent);}
      }
      this.segment=segment;this.size=(exists?this.size:0)+line.length;this.exists=true;
      this.remember(value);return value;
    }catch(error){this.failed=true;throw error;}
  }
}
