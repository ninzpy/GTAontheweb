const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
for (const ready of [false,true]) test(`launcher ${ready ? 'opens the selected game' : 'blocks incomplete storage'}`, async () => {
  const nodes = {};
  const node = id => nodes[id] ||= {events:{},value:'balanced',textContent:'',disabled:false,addEventListener(type,fn){this.events[type]=fn;},replaceChildren(){},append(){}};
  let destination;
  const context = vm.createContext({
    document:{getElementById:node,createElement:()=>({})},
    isSecureContext:true,crossOriginIsolated:true,SharedArrayBuffer,OffscreenCanvas:class {},
    WebAssembly:{validate:()=>true},URLSearchParams,AbortSignal,
    FormData:class {get(){return 'sandbox';}},
    navigator:{gpu:{requestAdapter:async()=>({features:new Set(['texture-compression-bc']),requestDevice:async()=>({destroy(){}})})}},
    fetch:async url=>url==='/api/game-status'
      ? {ok:ready,json:async()=>({ready})}
      : {ok:true,text:async()=>"importScripts('/chunk-index.js')"},
    location:{assign:url=>destination=url}
  });
  vm.runInContext(fs.readFileSync('public/assets/launcher.js','utf8'),context);
  await node('launch-form').events.submit({preventDefault(){}});
  if (ready) {
    const params = new URL(destination,'https://example.test');
    assert.equal(params.pathname,'/play/');
    assert.equal(params.searchParams.get('mode'),'sandbox');
    assert.equal(params.searchParams.get('res'),'1280x720');
  } else {
    assert.equal(destination,undefined);
    assert.match(node('feedback').textContent,/not ready/);
    assert.equal(node('play-button').disabled,false);
  }
});
