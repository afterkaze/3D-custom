const {app,BrowserWindow}=require('electron');
const path=require('node:path');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'check-prompts-preload.cjs'),sandbox:false,contextIsolation:true}});
 try{
 await win.loadFile(path.resolve('renderer/index.html'));
 await new Promise(r=>setTimeout(r,600));
 const result=await win.webContents.executeJavaScript(`(async()=>{
 const assert=(v,m)=>{if(!v)throw Error(m)};
 S.demo=false;S.games=[{id:'base',system:'ps2',title:'Base game',media:{},info:{}},{id:'dlc',system:'ps2',title:'DLC update',favorite:true,lastPlayed:1,hidden:true,media:{},info:{}}];
 refreshHiddenGames();
 assert(S.list.length===1&&S.list[0].id==='base','Hidden entry reached shelf');
 assert(!inView(S.games[1],'favorites')&&!inView(S.games[1],'recent'),'Hidden entry reached smart shelves');
 assert(document.querySelector('#systems button[data-id="all"]').title.includes('1 game'),'Wrong game count');
 assert(document.querySelectorAll('#hiddenGamesList button').length===1,'Restore control missing');
 S.games[0].hidden=true;refreshHiddenGames();assert(S.list.length===0&&!S.demo,'All-hidden library became demo');
 S.games[1].hidden=false;refreshHiddenGames();assert(S.list.length===1&&S.list[0].id==='dlc','Restored entry missing');
 assert(document.querySelector('#carousel .item').oncontextmenu,'Right-click handler missing');
 return 'PASS: shelf/count exclusion, favourites/recent exclusion, restore list, all-hidden empty state and right-click handler';
 })()`);
 console.log(result);app.exit(0);
 }catch(e){console.error(e);app.exit(1)}
});
