/* Merge physical, controller and touch keys before writing engine virtual keys. */
(() => {
  function create(keys, VK) {
    const sources = new Map();
    const aliases = {KeyI:'Numpad8',KeyK:'Numpad2',KeyJ:'Numpad4',KeyL:'Numpad6',KeyU:'Numpad7',KeyO:'Numpad9'};
    function sync() {
      const codes = new Set([...sources.values()].flatMap(value => [...value]));
      const down = new Set();
      for (const code of codes) {
        if (VK[code]) down.add(VK[code]);
        if (aliases[code] && VK[aliases[code]]) down.add(VK[aliases[code]]);
      }
      for (const [left,right,generic] of [['ShiftLeft','ShiftRight',0x10],['ControlLeft','ControlRight',0x11],['AltLeft','AltRight',0x12]]) {
        if (codes.has(left) || codes.has(right)) down.add(generic);
      }
      for (let i=0;i<256;i++) Atomics.store(keys,i,down.has(i)?128:0);
    }
    return {set(source,codes){sources.set(source,new Set(codes));sync();},clear(){sources.clear();sync();}};
  }
  globalThis.PlayGTA5Keys = {create};
  if (typeof module !== 'undefined') module.exports = {create};
})();
