import { readArchiveSymbols } from './radar_archive_read.mjs';
import Database from 'better-sqlite3';
import { readResearchQueue, readRadarDigest } from './radar_queue_read.mjs';
import { readScanDiagnostics, readScanStats } from './radar_status_read.mjs';
import { readControlNewsStorage } from './control_status_read.mjs';
let db;
process.on('disconnect',()=>{try{db?.close();}finally{process.exit(0);}});
process.on('message',({id,dbPath,operation,options})=>{
  let result;
  try {
    if(!db)db=new Database(dbPath,{readonly:true,fileMustExist:true,timeout:250});
    // readonly protects main; do not enable query_only, which also forbids TEMP writes.
    result=db.transaction(()=>{
      if(operation==='archive')return readArchiveSymbols(db,options);
      if(operation==='queue')return readResearchQueue(db,options);
      if(operation==='stats')return readScanStats(db);
      if(operation==='control'){
        const stats=readScanStats(db);
        return stats.ok?{ok:true,data:{stats:stats.data,news:readControlNewsStorage(db)},error:null}:stats;
      }
      if(operation==='diagnostics')return {ok:true,data:readScanDiagnostics(db),error:null};
      if(operation==='digest')return readRadarDigest(db,options.market,options.discovery);
      throw new Error('unknown_query_operation');
    })();
  } catch(error){result={ok:false,data:null,error:error?.message||String(error)};}
  if(process.connected)process.send({id,result});
});
