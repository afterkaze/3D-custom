// Verifies the native stereo cursor path: mouse movement does not re-render the eyes, the depth sent to the
// presenter equals half the hovered object's disparity, and host hit-testing matches the eyes' geometry.
// Usage: electron scripts/check-leia-cursor.cjs
const {app,BrowserWindow,ipcMain}=require('electron'),path=require('node:path');const {LeiaOutput}=require('../leia-output');
app.commandLine.appendSwitch('force-high-performance-gpu');process.env.LEIA_PROFILE='1';
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const host=new BrowserWindow({show:true,width:1440,height:900,webPreferences:{preload:path.join(__dirname,'bench-leia-preload.cjs'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
 host.isFocused=()=>true;let output,packets=0,recent=[];ipcMain.on('profile:snapshot',(_,data)=>{packets++;recent.push({attrs:data.attributes?Object.keys(data.attributes).join(','):'',patches:(data.patches||[]).map(p=>p.type+':'+p.id+':'+Object.keys(p.attributes||{}).join('|')).join(' '),anims:(data.animations||[]).length,cancels:(data.cancelAnimations||[]).length});recent=recent.slice(-4);output?.push({...data,active:false});});
 const timeout=setTimeout(()=>{output?.disable();console.error('timed out');app.exit(1)},60000);
 try{
  await host.loadFile(path.resolve('renderer/index.html'));await pause(1200);
  output=new LeiaOutput(host,()=>{});const enabled=output.enable();
  await host.webContents.executeJavaScript("Object.defineProperty(document,'hidden',{get:()=>false});document.hasFocus=()=>true;LeiaUI.toggle();LeiaUI.snapshot()");await enabled;
  await host.webContents.executeJavaScript("LeiaUI.setControls({depth:200,popout:150,convergence:0});0");await pause(1500);
  assert(output.nativeCursor===true,'Presenter did not start its native cursor pipeline');
  const point=await host.webContents.executeJavaScript("(()=>{const b=items.get(S.sel).getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),rendering:document.documentElement.dataset.leiaRendering,width:innerWidth}})()");
  assert(point.rendering==='true','Host is not in stereo rendering mode');
  // Moving within empty space must send nothing to the eyes.
  host.webContents.sendInputEvent({type:'mouseMove',x:20,y:Math.round(point.y)});await pause(300);
  const before=packets;for(let i=0;i<60;i++){host.webContents.sendInputEvent({type:'mouseMove',x:20+(i%10),y:Math.round(point.y)+(i%7)});await pause(8);}await pause(200);
  // 60 moves; a couple of unrelated UI updates (clock, toasts) may land in the window, but not one per move.
  assert(packets-before<=5,`Mouse movement still sends ${packets-before} packets to the eyes: ${JSON.stringify(recent)}`);
  host.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y});await pause(600);
  const hostHit=await host.webContents.executeJavaScript(`document.elementFromPoint(${point.x},${point.y})?.closest('.item')===items.get(S.sel)`);
  assert(hostHit,'Host hit-test does not land on the selected case under the pointer');
  const eyes=await output.mirror.webContents.executeJavaScript(`(()=>{const l=document.querySelector('#left').contentWindow,r=document.querySelector('#right').contentWindow,t=l.stereoCursorTarget();return {target:t,a:l.stereoNodeCenter(t),b:r.stereoNodeCenter(t)}})()`);
  assert(eyes.target,'Eyes did not receive the hovered object');
  const expected=(eyes.a-eyes.b)/2/point.width;
  assert(Math.abs(eyes.a-eyes.b)>2,'Hovered case has no stereo disparity; test is not meaningful');
  assert(Math.abs(output.cursorShift-expected)<1e-4,`Presenter cursor shift ${output.cursorShift} != ${expected}`);
  host.webContents.sendInputEvent({type:'mouseMove',x:20,y:20});await pause(400);
  assert(Math.abs(output.cursorShift)<1e-6,'Cursor did not return to screen depth over flat UI');
  console.log(`PASS: native cursor; mouse moves send no eye updates; depth shift ${(expected*point.width).toFixed(2)}px per eye matches the case; host hit-test matches`);
  output.disable();host.destroy();clearTimeout(timeout);setTimeout(()=>app.exit(0),500);
 }catch(e){console.error('FAIL',e.message);output?.disable();clearTimeout(timeout);app.exit(1)}
});
