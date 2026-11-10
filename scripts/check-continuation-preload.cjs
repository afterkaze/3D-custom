// Isolated fixture: no real ROM folders, downloads, launches, or saved settings.
const {contextBridge} = require('electron');
const config = {systems:[
  {id:'ps2',name:'PlayStation 2',caseType:'dvd',media:'disc',color:'#1d3f8f',romDir:'',extensions:['.iso'],emulator:''},
  {id:'gba',name:'Game Boy Advance',caseType:'cartbox',media:'cart',color:'#4b3a9b',romDir:'',extensions:['.gba'],emulator:''}
],emulators:{},customEmulators:[],hideWhilePlaying:true,uiSound:{enabled:false,volume:.25}};
contextBridge.exposeInMainWorld('api',{
  appVersion:async()=>'0.0.0-test',appCheckUpdate:async()=>null,appInstallUpdate:async()=>{},appOpenRelease:async()=>{},onAppUpdateProgress:()=>{},artSources:async()=>({launchbox:{built:0},screenscraper:{user:'',devId:'',hasPassword:false,hasDevPassword:false,ready:false}}),artSetScreenScraper:async()=>({launchbox:{built:0},screenscraper:{user:'',devId:'',ready:false}}),
  screenshotContextMenu:async()=>true,setHidden:async({hidden})=>({hidden}),setSystemGamesHidden:async({hidden})=>['b','b2','b3','b4','d'].map(gameId=>({gameId,hidden})),gameContextMenu:async()=>({action:'artwork'}),artImport:async({gameId,kind})=>({gameId,media:{[kind]:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='},replace:true}),saveGameOrder:async({gameIds})=>gameIds,setMetadata:async({title,version,mediaType})=>({title:title.trim(),version:version.trim(),mediaType,customTitle:true}),getConfig:async()=>config, scan:async()=>[],emuList:async()=>[],onToast:()=>{},onProgress:()=>{},fetchArt:async()=>null,
  setConfig:async c=>Object.assign(config,c),openManual:async()=>{},launch:async()=>{},pickFolder:async()=>null
});
