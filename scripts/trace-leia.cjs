// Records a Chromium trace of the stereo pipeline while navigating. Usage: electron scripts/trace-leia.cjs <out.json> [--large] [--interval=ms] [--quality=ultra] [--mem=MB]
const {app,BrowserWindow,ipcMain,contentTracing}=require('electron'),path=require('node:path');const {LeiaOutput}=require('../leia-output');
app.commandLine.appendSwitch('force-high-performance-gpu');process.env.LEIA_PROFILE='1';
const mem=process.argv.find(a=>a.startsWith('--mem='));if(mem)app.commandLine.appendSwitch('force-gpu-mem-available-mb',mem.slice(6));
const out=process.argv.find(a=>a.endsWith('.json'))||'leia-trace.json';const interval=Number((process.argv.find(a=>a.startsWith('--interval='))||'=450').split('=')[1]);
app.whenReady().then(async()=>{
 const large=process.argv.includes('--large');const host=new BrowserWindow({show:true,width:large?3840:1440,height:large?2160:900,webPreferences:{preload:path.join(__dirname,'bench-leia-preload.cjs'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
 host.isFocused=()=>true;let output;ipcMain.on('profile:snapshot',(_,data)=>output?.push({...data,active:data.active}));
 const timeout=setTimeout(()=>{output?.disable();app.exit(1)},90000);
 try{
  if(large)host.setFullScreen(true);await host.loadFile(path.resolve('renderer/index.html'));await new Promise(r=>setTimeout(r,1200));
  output=new LeiaOutput(host,()=>{});output.quality=(process.argv.find(a=>a.startsWith('--quality='))||'=native').split('=')[1];const enabled=output.enable();
  await host.webContents.executeJavaScript("Object.defineProperty(document,'hidden',{get:()=>false});LeiaUI.toggle();LeiaUI.snapshot()");await enabled;
  console.log('pids',JSON.stringify({host:host.webContents.getOSProcessId(),mirror:output.mirror.webContents.getOSProcessId()}));
  const counts=await output.mirror.webContents.executeJavaScript("['left','right'].map(id=>document.querySelector('#'+id).contentDocument.querySelectorAll('*').length)");
  const hostCount=await host.webContents.executeJavaScript("document.querySelectorAll('*').length+' list:'+S.list.length");console.log('nodes',counts,hostCount);
  await new Promise(r=>setTimeout(r,800));
  await contentTracing.startRecording({included_categories:['devtools.timeline','blink','cc','gpu','viz','benchmark','v8.execute','disabled-by-default-devtools.timeline','disabled-by-default-cc.debug']});
  if(process.argv.includes('--mouse')){const [w,h]=host.getContentSize();const t0=Date.now();await new Promise(done=>{const timer=setInterval(()=>{const t=(Date.now()-t0)/1000;if(t>4){clearInterval(timer);return done();}host.webContents.sendInputEvent({type:'mouseMove',x:Math.round(w/2+Math.cos(t*3)*w*.3),y:Math.round(h/2+Math.sin(t*3)*h*.3)});},8);});}
  else{await host.webContents.executeJavaScript("window.n=0;window.profileNavigation=setInterval(()=>{navigateGame(++n%6<3?1:-1)},"+interval+")");
  await new Promise(r=>setTimeout(r,4000));
  await host.webContents.executeJavaScript('clearInterval(window.profileNavigation)');}
  const file=await contentTracing.stopRecording(path.resolve(out));console.log('trace',file);
  output.disable();host.destroy();clearTimeout(timeout);setTimeout(()=>app.exit(0),500);
 }catch(e){console.error(e);output?.disable();clearTimeout(timeout);app.exit(1)}
});
