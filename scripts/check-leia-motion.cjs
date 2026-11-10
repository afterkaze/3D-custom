// Verifies that shelf movement keeps animating in the stereo eyes when a neighbouring-console preview appears or
// disappears in the same step (the eye used to re-insert #carousel, cancelling every running transition).
// Usage: electron scripts/check-leia-motion.cjs
const {app,BrowserWindow,ipcMain}=require('electron'),path=require('node:path');const {LeiaOutput}=require('../leia-output');
app.commandLine.appendSwitch('force-high-performance-gpu');process.env.LEIA_PROFILE='1';
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const host=new BrowserWindow({show:true,width:1440,height:900,webPreferences:{preload:path.join(__dirname,'bench-leia-preload.cjs'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
 host.isFocused=()=>true;let output;ipcMain.on('profile:snapshot',(_,data)=>output?.push({...data,active:false}));
 const timeout=setTimeout(()=>{output?.disable();console.error('timed out');app.exit(1)},60000);
 try{
  await host.loadFile(path.resolve('renderer/index.html'));await pause(1200);
  output=new LeiaOutput(host,()=>{});const enabled=output.enable();
  await host.webContents.executeJavaScript("Object.defineProperty(document,'hidden',{get:()=>false});document.hasFocus=()=>true;LeiaUI.toggle();LeiaUI.snapshot()");await enabled;await pause(1500);
  const count=await host.webContents.executeJavaScript('S.list.length');assert(count>=4,'Demo shelf too small');
  const eye="document.querySelector('#right').contentWindow";
  const results=[];
  // Steps into the last two games (preview appears) and back out (preview leaves), plus a plain middle step.
  for(const index of [count-4,count-3,count-2,count-1,count-2,count-3]){
   await output.mirror.webContents.executeJavaScript(`(()=>{const d=${eye}.document;d.querySelector('#carousel').__mark=1;})()`);
   // A sibling added to #stage in the same frame is what a console preview appearing looks like to the eyes.
   await host.webContents.executeJavaScript(`select(${index});{const probe=document.createElement('div');probe.className='leia-motion-probe';$('#stage').append(probe);setTimeout(()=>probe.remove(),300);}0`);await pause(140);
   const r=await output.mirror.webContents.executeJavaScript(`(()=>{const w=${eye},d=w.document,c=d.querySelector('#carousel');return {same:c.__mark===1,moving:c.getAnimations({subtree:true}).filter(a=>a.constructor.name==='CSSTransition'&&a.playState==='running').length,previews:d.querySelectorAll('.console-preview:not(.preview-leaving)').length}})()`);
   results.push({index,...r});await pause(700);
  }
  console.log(JSON.stringify(results));
  for(const r of results){assert(r.same,`Eye carousel was re-inserted at index ${r.index}`);assert(r.moving>0,`No shelf animation in the eye at index ${r.index}`);}
  // Preview visibility rules (host side): none mid-shelf, shown at the shelf end.
  const rule=await host.webContents.executeJavaScript(`(async()=>{const wait=ms=>new Promise(r=>setTimeout(r,ms)),count=()=>document.querySelectorAll('.console-preview:not(.preview-leaving)').length;const sys=S.config.systems.find(s=>!s.hidden&&S.games.filter(g=>g.system===s.id&&!g.hidden).length>=1);setSystem(sys.id,1);layout();await wait(500);const end=count();return {system:sys.id,end,len:S.list.length};})()`);
  console.log(JSON.stringify(rule));
  assert(rule.end>0,'Console preview did not appear at the end of a console shelf');
  console.log('PASS: shelf animates in the eyes across console-preview changes; previews only near the shelf ends');
  output.disable();host.destroy();clearTimeout(timeout);setTimeout(()=>app.exit(0),500);
 }catch(e){console.error('FAIL',e.message);output?.disable();clearTimeout(timeout);app.exit(1)}
});
