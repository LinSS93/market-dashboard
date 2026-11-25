// Dedicated read process. Never imports the scanner or invokes schema migration.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const failure = error => ({ok:false,data:null,error});
export class RadarQueryProcess {
  constructor({dbPath,timeoutMs=10000,maxQueue=8,workerFile=new URL('./radar_query_worker.mjs',import.meta.url)}={}) {
    this.dbPath=dbPath;this.timeoutMs=timeoutMs;this.maxQueue=maxQueue;this.workerFile=workerFile;
    this.child=null;this.active=null;this.queue=[];this.pending=new Map();this.sequence=0;this.generation=0;this.stopping=false;this.closed=false;
  }
  query(operation,options={}) {
    if(this.closed)return Promise.resolve(failure('query_service_closed'));
    const key=JSON.stringify([this.generation,operation,options]);
    if(this.pending.has(key))return this.pending.get(key).promise;
    if(this.queue.length>=this.maxQueue)return Promise.resolve(failure('query_queue_full'));
    let resolve;const promise=new Promise(r=>resolve=r);
    const job={id:++this.sequence,key,operation,options,generation:this.generation,promise,resolve};
    job.timer=setTimeout(()=>{
      if(this.active===job){this.retire();this.active=null;}
      else this.queue=this.queue.filter(item=>item!==job);
      this.finish(job,failure('query_timeout'));
      this.pump();
    },this.timeoutMs);
    this.pending.set(key,job);this.queue.push(job);this.pump();return promise;
  }
  finish(job,result) {
    clearTimeout(job.timer);this.pending.delete(job.key);job.resolve(result);
  }
  retire() {
    const child=this.child;
    if(child){this.child=null;this.stopping=true;child.kill();}
  }
  pump() {
    if(this.closed||this.stopping||this.active||!this.queue.length)return;
    if(!this.child){
      const child=fork(this.workerFile instanceof URL?fileURLToPath(this.workerFile):this.workerFile,[],{
        windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],serialization:'advanced',execArgv:[],
      });
      this.child=child;
      child.stderr.on('data',()=>{});
      child.on('message',message=>{
        if(child!==this.child||!this.active||message.id!==this.active.id)return;
        const job=this.active;this.active=null;
        this.finish(job,job.generation===this.generation?message.result:failure('query_superseded'));
        this.pump();
      });
      child.on('error',()=>{if(child===this.child){this.retire();if(this.active){this.finish(this.active,failure('query_worker_exited'));this.active=null;}}});
      child.once('close',()=>{
        if(child===this.child){this.child=null;if(this.active){this.finish(this.active,failure('query_worker_exited'));this.active=null;}}
        this.stopping=false;this.pump();
      });
    }
    const job=this.active=this.queue.shift();
    const onSendError=error=>{
      if(error&&this.active===job){this.retire();this.active=null;this.finish(job,failure('query_worker_send_failed'));}
    };
    try {this.child.send({id:job.id,dbPath:this.dbPath,operation:job.operation,options:job.options},onSendError);}
    catch(error){onSendError(error);}
  }
  invalidate() {
    this.generation++;
    for(const job of this.queue)this.finish(job,failure('query_superseded'));
    this.queue=[];
    if(this.active){const job=this.active;this.retire();this.active=null;this.finish(job,failure('query_superseded'));}
  }
  close() {
    this.closed=true;
    for(const job of this.pending.values()){clearTimeout(job.timer);job.resolve(failure('query_service_closed'));}
    this.pending.clear();this.queue=[];this.active=null;this.retire();
  }
}
