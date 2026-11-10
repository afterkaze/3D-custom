const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const s=fs.readFileSync('main.js','utf8');const start=s.indexOf("win.webContents.on('before-input-event'");const end=s.indexOf('\n  });',start)+6;
let handler,full=false,toggles=0,prevented=0;
vm.runInNewContext(s.slice(start,end),{win:{webContents:{on:(_,fn)=>handler=fn},isFullScreen:()=>full,setFullScreen:v=>{full=v;toggles++}}});
const send=(type,key='F11',isAutoRepeat=false)=>handler({preventDefault:()=>prevented++},{type,key,isAutoRepeat});
send('keyDown');assert.equal(full,true);send('keyDown','F11',true);send('keyUp');assert.equal(toggles,1);assert.equal(prevented,3);send('keyDown');assert.equal(full,false);send('keyDown','a');assert.equal(toggles,2);
console.log('PASS: F11 consumes default accelerator, toggles once, ignores key repeat and other keys');
