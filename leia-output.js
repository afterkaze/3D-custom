const {BrowserWindow,app,screen}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
class LeiaOutput {
 constructor(host,onStatus){this.host=host;this.onStatus=onStatus;this.pending=new Map();this.id=0;this.enabled=false;this.starting=false;this.mirrorReady=false;this.backlog=[];this.completed=0;this.sampleTime=Date.now();this.sampleFrames=0;this.lastActive=null;this.layout='leia';}
 direct(){return this.layout!=='leia';}
 executable(){return app.isPackaged?path.join(process.resourcesPath,'leia','PyroCadeLeia.exe'):path.join(__dirname,'native','bin','PyroCadeLeia.exe');}
 status(){return {enabled:this.enabled,pending:this.starting,layout:this.layout,available:this.direct()||process.platform==='win32'&&fs.existsSync(this.executable()),message:this.message||''};}
 notify(message=''){this.message=message;this.onStatus(this.status());}
 async enable(){
  if(this.enabled)return this.status();if(this.starting)throw Error('Leia SR is still starting.');
  if(this.direct())return this.enableDirect();
  if(!this.status().available)throw Error('Leia SR is only available in the Windows build with the native presenter.');
  this.cadence=null;this.starting=true;this.notify();
  const owner=this.host.getNativeWindowHandle().readBigUInt64LE(0).toString();
  const child=this.child=spawn(this.executable(),[owner,String(process.pid)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const bounds=this.host.getContentBounds();this.renderSize=this.renderBounds(bounds.width,bounds.height);this.expectedPixels=null;this.renderEpoch=1;
  this.mirror=new BrowserWindow({x:bounds.x,y:bounds.y,width:this.renderSize.width,height:this.renderSize.height,show:false,frame:false,enableLargerThanScreen:true,webPreferences:{preload:path.join(__dirname,'leia-mirror-preload.js'),contextIsolation:true,sandbox:false,offscreen:{useSharedTexture:true},backgroundThrottling:false}});
  this.sizeMirror(this.renderSize);
  this.targetFPS=Math.max(60,Math.min(120,Math.round(screen.getDisplayMatching(bounds).displayFrequency||60)));this.mirror.webContents.setFrameRate(this.targetFPS);
  this.cursorShift=null;
  this.mirror.webContents.on('ipc-message',(_,channel,value,size)=>{if(channel==='leia:cursorDepth')this.setCursorDepth(value);if(channel==='leia:mirrorStats')this.sceneStats=value;if(channel==='leia:mirrorReady'&&value===this.renderEpoch){this.expectedPixels=size;this.mirror.webContents.invalidate();}});
  // Only switch painting when the state changes: startPainting() restarts Chromium's frame capturer and drops the
  // frames in flight, so calling it on every update (60+/s while dragging the case) starved the presenter.
  this.painting=()=>{if(!this.mirror||this.mirror.isDestroyed())return;const paint=!this.enabled||!!(this.lastSnapshot?.active&&this.host.isFocused()&&!this.host.isMinimized());if(paint===this.mirror.webContents.isPainting())return;if(paint)this.mirror.webContents.startPainting();else this.mirror.webContents.stopPainting();};
  this.focusListener=()=>this.painting();this.host.on('focus',this.focusListener);this.host.on('blur',this.focusListener);
  this.mirror.webContents.on('paint',(event)=>{
   const texture=event.texture;if(!texture)return;
   const handle=texture.textureInfo?.handle?.ntHandle;
   if(!this.hasSnapshot||!handle||this.pending.size>=2||!this.child||texture.textureInfo.widgetType==='popup'){texture.release();return;}
   const size=texture.textureInfo.codedSize;if(!this.expectedPixels||Math.abs(size.width-this.expectedPixels.width)>2||Math.abs(size.height-this.expectedPixels.height)>2||size.width>8192||size.height>4320){texture.release();return;}this.textureSize=size;
   const id=++this.id;this.pending.set(id,texture);
   child.stdin.write('FRAME '+id+' '+handle.readBigUInt64LE(0).toString()+'\n',error=>{if(error)this.fail('The SR presenter connection closed.');});
  });
  this.mirror.webContents.once('did-finish-load',()=>{this.mirrorReady=true;const pending=this.backlog;this.backlog=[];for(const packet of pending)this.push(packet);});
  this.mirror.loadFile(path.join(__dirname,'renderer','leia-mirror.html')).catch(()=>this.fail('Could not load the stereo scene.'));
  this.host.webContents.send('leia:status',this.status());
  return await new Promise((resolve,reject)=>{
   this.resolve=resolve;this.reject=reject;this.timeout=setTimeout(()=>this.fail('Leia SR did not receive a stereo frame. The launcher is back in 2D.'),25000);
   let output='';child.stdout.on('data',data=>{output+=data.toString();const lines=output.split('\n');output=lines.pop();for(const line of lines){let event;try{event=JSON.parse(line)}catch{continue;}
    if(event.type==='release'){this.pending.get(event.id)?.release();this.pending.delete(event.id);if(event.copied!==false)this.completed++;}
    if(event.type==='cadence')this.cadence=event;
    if(event.type==='gpu')this.nativeGPU=event.name;
    if(event.type==='cursor')this.nativeCursor=!!event.native;
    if(event.type==='cursorState')this.cursorState=event;
    if(event.type==='dump')this.dumpInfo=event;
    if(event.type==='ready'){clearTimeout(this.timeout);this.enabled=true;this.starting=false;this.notify();this.painting();this.resolve?.(this.status());this.resolve=null;this.reject=null;}
    if(event.type==='error')this.fail(event.message);
   }});
   child.on('error',()=>this.fail('Could not start the native SR presenter.'));
   child.on('exit',()=>{if(this.child===child)this.fail('Leia SR presenter closed. The launcher is back in 2D.');});
   child.stderr.on('data',()=>{});
  });
 }
 // Non-Leia outputs (glasses / 3D TVs / projectors): no weaver. The stereo mirror itself is shown in a
 // click-through window over the launcher, laid out as side-by-side, over-under or row-interlaced.
 async enableDirect(){
  this.starting=true;this.notify();
  const bounds=this.host.getContentBounds();this.renderSize=this.renderBounds(bounds.width,bounds.height);this.renderEpoch=1;
  const mirror=this.mirror=new BrowserWindow({x:bounds.x,y:bounds.y,width:this.renderSize.width,height:this.renderSize.height,show:false,frame:false,parent:this.host,focusable:false,skipTaskbar:true,resizable:false,hasShadow:false,enableLargerThanScreen:true,backgroundColor:'#07080c',webPreferences:{preload:path.join(__dirname,'leia-mirror-preload.js'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
  mirror.setIgnoreMouseEvents(true);this.sizeMirror(this.renderSize);
  mirror.webContents.on('ipc-message',(_,channel,value)=>{if(channel==='leia:mirrorStats')this.sceneStats=value;});
  // Shown only while the 3D scene is up and the launcher is focused, so dialogs, games and other apps stay in 2D.
  this.painting=()=>{if(!this.mirror||this.mirror.isDestroyed())return;const show=this.enabled&&!!(this.lastSnapshot?.active&&this.host.isFocused()&&!this.host.isMinimized());if(show===this.mirror.isVisible())return;if(show)this.mirror.showInactive();else this.mirror.hide();};
  this.focusListener=()=>{if(this.mirror&&!this.mirror.isDestroyed()){const b=this.host.getContentBounds();this.mirror.setPosition(b.x,b.y);}this.painting();};
  for(const event of LeiaOutput.hostEvents)this.host.on(event,this.focusListener);
  return await new Promise((resolve,reject)=>{
   this.resolve=resolve;this.reject=reject;
   mirror.webContents.once('did-finish-load',()=>{this.mirrorReady=true;this.enabled=true;this.starting=false;const pending=this.backlog;this.backlog=[];for(const packet of pending)this.push(packet);this.notify();this.painting();this.resolve?.(this.status());this.resolve=null;this.reject=null;});
   mirror.loadFile(path.join(__dirname,'renderer','leia-mirror.html')).catch(()=>this.fail('Could not load the stereo scene.'));
   this.host.webContents.send('leia:status',this.status());
  });
 }
 // Switching output while 3D is on restarts it in the new layout (the Leia weaver and direct output differ).
 async setLayout(layout){
  if(!LeiaOutput.layouts[layout])throw Error('Unknown 3D display output.');if(layout===this.layout)return this.status();
  const restart=this.enabled||this.starting;if(restart)this.stop();this.layout=layout;
  if(!restart){this.notify();return this.status();}
  return await this.enable();
 }
 push(snapshot){
  if(!this.mirror)return;this.lastSnapshot=snapshot;snapshot.layout=this.layout;
  const active=!!snapshot.active;if(this.lastActive!==active){this.child?.stdin.write('ACTIVE '+(active?1:0)+'\n',()=>{});this.lastActive=active;}
  if(!this.mirrorReady){if(typeof snapshot.html==='string')this.backlog=[snapshot];else this.backlog.push(snapshot);return;}
  const desired=this.renderBounds(snapshot.width,snapshot.height),size=this.renderSize;if(size.width!==desired.width||size.height!==desired.height||size.displayId!==desired.displayId){if(size.displayId!==desired.displayId){const bounds=this.host.getContentBounds();this.mirror.setPosition(bounds.x,bounds.y);}this.renderSize=desired;this.expectedPixels=null;this.renderEpoch++;this.sizeMirror(desired);}
  if(typeof snapshot.html==='string')this.hasSnapshot=true;this.mirror.webContents.send('leia:mirror',{...snapshot,renderEpoch:this.renderEpoch});this.painting();
 }
 // Each eye keeps the launcher's own CSS viewport; only the backing surface changes.
 // native: the side-by-side surface matches the window's device pixels, so each eye gets full vertical
 //   resolution and the half of the horizontal columns a 2-view lenticular panel actually shows that eye.
 // ultra: each eye at the full window resolution (twice the pixels, for very fast GPUs).
 // performance: bounded surface for slower GPUs.
 renderBounds(width,height){const display=screen.getDisplayMatching(this.host.getContentBounds()),dpi=display.scaleFactor||1;
  if(this.direct()){const l=LeiaOutput.layouts[this.layout];return{displayId:display.id,width:Math.round(width*l.w),height:Math.round(height*l.h)};}
  const q=LeiaOutput.qualities[this.quality]||LeiaOutput.qualities.native;const eye=width*q.eye;const scale=Math.min(1,q.max[0]/(2*eye*dpi),q.max[1]/(height*dpi));return{displayId:display.id,width:Math.max(200,Math.floor(eye*scale)*2),height:Math.max(100,Math.floor(height*scale))};}
 // The presenter draws the cursor itself from the real mouse position; it only needs the per-eye shift
 // (fraction of the viewport width) that puts the cursor at the depth of the object under it.
 setCursorDepth(value){const shift=Number(value);if(!this.child||!Number.isFinite(shift))return;const clamped=Math.max(-.25,Math.min(.25,shift));if(this.cursorShift!==null&&Math.abs(clamped-this.cursorShift)<1e-5)return;this.cursorShift=clamped;this.child.stdin.write('CURSOR '+clamped.toFixed(6)+'\n',()=>{});}
 // Windows clamps ordinary windows to the monitor's work area, but the side-by-side surface is twice the
 // window width. Raising the minimum size first lets the hidden mirror take its full stereo size.
 sizeMirror(size){if(!this.mirror||this.mirror.isDestroyed())return;this.mirror.setMinimumSize(1,1);this.mirror.setContentSize(size.width,size.height);this.mirror.setMinimumSize(size.width,size.height);this.mirror.setContentSize(size.width,size.height);}
 setQuality(quality){if(!LeiaOutput.qualities[quality]||quality===this.quality)return;this.quality=quality;if(this.lastSnapshot&&this.mirrorReady)this.push({...this.lastSnapshot,html:undefined,patches:[],textures:[],animations:[],cancelAnimations:[]});}
 diagnostics(){const now=Date.now(),elapsed=now-this.sampleTime;const fps=elapsed>0?(this.completed-this.sampleFrames)*1000/elapsed:0;this.sampleFrames=this.completed;this.sampleTime=now;return{enabled:this.enabled,layout:this.layout,nativeGPU:this.nativeGPU||'',fps,targetFPS:this.targetFPS||60,cadence:this.cadence||null,cursor:this.cursorState||null,scene:this.sceneStats||null,textureSize:this.textureSize||null};}
 fail(message){const reject=this.reject;this.reject=null;this.resolve=null;this.stop();this.notify(message);reject?.(new Error(message));}
 stop(){
  clearTimeout(this.timeout);if(this.focusListener)for(const event of LeiaOutput.hostEvents)this.host.removeListener(event,this.focusListener);this.focusListener=null;this.backlog=[];this.lastActive=null;const child=this.child;this.child=null;this.enabled=false;this.starting=false;this.mirrorReady=false;this.hasSnapshot=false;
  if(child){child.stdin.end('QUIT\n');const kill=setTimeout(()=>child.kill(),1000);child.once('exit',()=>clearTimeout(kill));}
  if(this.mirror&&!this.mirror.isDestroyed())this.mirror.destroy();this.mirror=null;
  for(const texture of this.pending.values())texture.release();this.pending.clear();
 }
 disable(){this.stop();this.notify();return this.status();}
}
// eye: per-eye width relative to the window; max: side-by-side surface limit in device pixels.
LeiaOutput.qualities={ultra:{eye:1,max:[8192,4320]},native:{eye:.5,max:[8192,4320]},performance:{eye:.5,max:[2560,1440]}};
// w/h: output surface relative to the launcher window. Full side-by-side / over-under keep each eye at full
// resolution, so the output is twice as wide / tall (spanned displays, projectors, HMDs).
LeiaOutput.layouts={leia:{w:1,h:1},'sbs-half':{w:1,h:1},'sbs-full':{w:2,h:1},'ou-half':{w:1,h:1},'ou-full':{w:1,h:2},interlaced:{w:1,h:1}};
LeiaOutput.hostEvents=['focus','blur','move','resize','minimize','restore'];
module.exports={LeiaOutput};
