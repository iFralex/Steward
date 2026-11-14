import { openSync,readSync,closeSync } from 'node:fs';
const fd=openSync(process.argv[2],'r'),buf=Buffer.allocUnsafe(32*65536);let calls=0,input=0,output=0,cacheRead=0,cacheWrite=0,cost=0,n;
while((n=readSync(fd,buf,0,buf.length,null))>0){if(n%32)throw Error('partial record');for(let i=0;i<n;i+=32){calls++;input+=buf.readUInt32LE(i);output+=buf.readUInt32LE(i+4);cacheRead+=buf.readUInt32LE(i+8);cacheWrite+=buf.readUInt32LE(i+12);cost+=buf.readDoubleLE(i+16);}}
closeSync(fd);console.log(JSON.stringify({calls,input,output,cacheRead,cacheWrite,cost}));
