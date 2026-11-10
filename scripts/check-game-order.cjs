const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('main.js','utf8'),handlers={},files=new Map();
const state=source.slice(source.indexOf('const emptyState ='),source.indexOf('// ---------- Library scanning'));
const actions=source.slice(source.indexOf("handle('library:gameOrders'"),source.indexOf("handle('library:ui'"));
const context=vm.createContext({fs:{mkdirSync(){},writeFileSync(p,v){files.set(p,v)},renameSync(a,b){files.set(b,files.get(a))},readFileSync(p){if(!files.has(p))throw Error('missing');return files.get(p)}},DATA:'fixture',STATE_PATH:'state',console,setTimeout,clearTimeout,handle:(id,fn)=>handlers[id]=fn,libraryGames:[{id:'a',system:'switch'},{id:'b',system:'switch'},{id:'c',system:'recomp'}],config:{systems:[{id:'switch'},{id:'recomp'}]}});
vm.runInContext(state+actions,context);
handlers['library:saveGameOrder']({system:'switch',gameIds:['b','a']});vm.runInContext('libraryState=loadState()',context);assert.equal(handlers['library:gameOrders']().switch.join(','),'b,a');
assert.throws(()=>handlers['library:saveGameOrder']({system:'switch',gameIds:['c']}));assert.throws(()=>handlers['library:saveGameOrder']({system:'switch',gameIds:['a','a']}));assert.throws(()=>handlers['library:saveGameOrder']({system:'missing',gameIds:[]}));
handlers['library:saveGameOrder']({system:'switch',gameIds:['b']});assert.equal(handlers['library:gameOrders']().switch.join(','),'b,a');console.log('PASS: custom order persists by console, keeps remaining games and rejects cross-console or duplicate IDs');
