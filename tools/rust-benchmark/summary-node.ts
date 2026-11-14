import Database from 'better-sqlite3';
import {UsageLedger} from '../../packages/usage-ledger/src/index.ts';
const [path,now,days]=process.argv.slice(2);Date.now=()=>Number(now);
const db=new Database(path,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');db.exec('BEGIN');
try{const result=UsageLedger.prototype.summary.call({raw:db} as UsageLedger,days==='all'?undefined:Number(days));console.log(JSON.stringify(result));}finally{db.exec('COMMIT');db.close()}
