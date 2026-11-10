// Captures the game details panel at each size with a long title, version and description.
// Usage: electron scripts/capture-details.cjs <outDir> [width height]
const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs');
const out=process.argv[2]||'details-shots';const W=Number(process.argv[3]||1600),H=Number(process.argv[4]||900);
app.whenReady().then(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const win=new BrowserWindow({show:false,width:W,height:H,useContentSize:true,webPreferences:{preload:path.join(__dirname,'bench-leia-preload.cjs'),contextIsolation:true,sandbox:false,offscreen:true}});
 try{
  await win.loadFile(path.resolve('renderer/index.html'));await new Promise(r=>setTimeout(r,1500));
  await win.webContents.executeJavaScript(`(()=>{const g=S.list[S.sel];g.title='The Legend of Zelda: Tears of the Kingdom — Special Collector Edition Deluxe';g.version='1.4.3 (Update 7)';g.info={...g.info,year:'2023',developer:'Nintendo EPD Production Group No. 3',genre:'Action-adventure',players:'1',description:'An epic adventure across the land and skies of Hyrule awaits. Explore vast floating islands, uncover the mysteries of an ancient civilization, and craft wild contraptions with new abilities. This is a deliberately long description to check clamping, scrolling and ellipsis behaviour at every details size, including the smallest grip position and the fully expanded panel.'};g.customTitle=true;showInfo();})()`);
  const shots=[['small',"Appearance.apply({infoBar:'small'},false);DetailsResize.reset()"],['large',"Appearance.apply({infoBar:'large'},false);DetailsResize.reset()"],['xlarge',"Appearance.apply({infoBar:'xlarge'},false);DetailsResize.reset()"],['drag-min',"Appearance.apply({infoBar:'xlarge'},false);DetailsResize.setHeight(0)"],['drag-mid',"Appearance.apply({infoBar:'xlarge'},false);DetailsResize.setHeight((128+DetailsResize.max())/2)"],['drag-max',"Appearance.apply({infoBar:'xlarge'},false);DetailsResize.setHeight(9999)"]];
  for(const [name,js] of shots){await win.webContents.executeJavaScript(js+';resizeShelf();layout();0');await new Promise(r=>setTimeout(r,900));const img=await win.webContents.capturePage();fs.writeFileSync(path.join(out,name+'.png'),img.toPNG());
   const m=await win.webContents.executeJavaScript(`(()=>{const r=e=>{const b=$(e).getBoundingClientRect();return [Math.round(b.x),Math.round(b.y),Math.round(b.width),Math.round(b.height)]};return {info:r('#info'),text:r('#info .info-text'),title:r('#gTitle'),meta:r('#gMeta'),desc:r('#gDesc'),actions:r('#info .actions'),titleFont:getComputedStyle($('#gTitle')).fontSize}})()`);console.log(name,JSON.stringify(m));}
 }catch(e){console.error(e);}
 app.exit(0);
});
