import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const [server, log, delay] = process.argv.slice(2);
let late = false;
const names = ['echo', 'a.b', 'a_b', 'x'.repeat(90), 'slash/name', 'read-file'];
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\n');
appendFileSync(log, JSON.stringify({server, start:process.pid})+'\n');
createInterface({input:process.stdin}).on('line', async line => {
 const m = JSON.parse(line); if(m.id === undefined) return;
 appendFileSync(log, JSON.stringify({server, method:m.method, params:m.params})+'\n');
 let result;
 switch(m.method) {
 case 'initialize': await new Promise(resolve => setTimeout(resolve, Number(delay) || 0)); result={protocolVersion:'2024-11-05', capabilities:{tools:{listChanged:true},resources:{}},serverInfo:{name:server,version:'1'},instructions:`fixture instructions ${server}`}; break;
 case 'ping': result={}; break;
 case 'tools/list': result={tools:[...names,...(late?['late']:[])].map(name=>({name,description:`${server} fixture ${name}`,inputSchema:{type:'object',properties:{}}}))}; break;
 case 'tools/call':
  result={content:[{type:'text',text:JSON.stringify({server,original:m.params.name})}]};
  if(m.params.name==='echo'&&!late) {late=true; setTimeout(()=>send({method:'notifications/tools/list_changed'}),10);}
  break;
 case 'resources/list': result={resources:[{uri:`fixture://${server}/secret`,name:`${server}-resource`}]}; break;
 case 'resources/templates/list': result={resourceTemplates:[{uriTemplate:`fixture://${server}/{id}`,name:`${server}-template`}]}; break;
 case 'resources/read': result={contents:[{uri:m.params.uri,text:`${server}-resource-body`}]}; break;
 default: send({id:m.id,error:{code:-32601,message:'Unsupported fixture request'}}); return;
 }
 send({id:m.id,result});
});
