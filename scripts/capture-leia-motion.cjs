// Captures consecutive stereo frames (as delivered to the presenter) while the shelf moves left/right.
// Usage: electron scripts/capture-leia-motion.cjs <outDir> [--large]
const {app,BrowserWindow,ipcMain}=require('electron'),path=require('node:path'),fs=require('node:fs');const {LeiaOutput}=require('../leia-output');
app.commandLine.appendSwitch('force-high-performance-gpu');process.env.LEIA_PROFILE='1';
const out=process.argv.find(a=>!a.startsWith('-')&&!a.endsWith('.cjs')&&!a.endsWith('.exe')&&a!=='.')||'leia-motion';
app.whenReady().then(async()=>{
 fs.mkdirSync(out,{recursive:true});const large=process.argv.includes('--large');
 const host=new BrowserWindow({show:true,width:large?3840:1440,height:large?2160:900,webPreferences:{preload:path.join(__dirname,'bench-leia-preload.cjs'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
 host.isFocused=()=>true;let output;ipcMain.on('profile:snapshot',(_,data)=>output?.push({...data,active:false}));
 try{
  if(large)host.setFullScreen(true);await host.loadFile(path.resolve('renderer/index.html'));await new Promise(r=>setTimeout(r,1200));
  output=new LeiaOutput(host,()=>{});const enabled=output.enable();
  await host.webContents.executeJavaScript("Object.defineProperty(document,'hidden',{get:()=>false});document.hasFocus=()=>true;LeiaUI.toggle();LeiaUI.snapshot()");await enabled;await new Promise(r=>setTimeout(r,1500));
  let n=0;for(const dir of [1,1,-1]){await host.webContents.executeJavaScript('navigateGame('+dir+');0');for(let i=0;i<8;i++){await new Promise(r=>setTimeout(r,45));const img=await output.mirror.webContents.capturePage();fs.writeFileSync(path.join(out,String(n++).padStart(2,'0')+'.png'),img.resize({width:1280}).toPNG());}await new Promise(r=>setTimeout(r,500));}
  console.log('captured',n);
 }catch(e){console.error(e);}
 output?.disable();host.destroy();setTimeout(()=>app.exit(0),500);
});
