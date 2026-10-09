import fs from 'node:fs/promises';
import path from 'node:path';
import {saveJSON} from './harness.mjs';
const up=process.argv[2];if(!up)throw Error('用法：node scripts/audit/upstream.mjs <固定SHA的上游工作区>');
const shortcutSource='Compositor/UI/KeyboardShortcuts.swift',appSource='Compositor/CompositorApp.swift';
const text=await fs.readFile(path.join(up,shortcutSource),'utf8'),app=await fs.readFile(path.join(up,appSource),'utf8');
const definition=text.slice(text.indexOf('static let all:'),text.indexOf('@MainActor @Observable'));
const unescape=s=>s.replace(/\\u\{([a-f\d]+)\}/gi,(_,h)=>String.fromCodePoint(parseInt(h,16))).replaceAll('\\t','\t').replaceAll('\\r','\r').replaceAll('\\n','\n');
const shortcuts=[];
function add(title,key,bits=0,origin='静态 entry',sourceLine){shortcuts.push({id:'NKEY-'+String(shortcuts.length+1).padStart(3,'0'),title,key:unescape(key),bits,origin,source:shortcutSource,line:sourceLine});}
for(const m of definition.matchAll(/entry\("([^"\n]+)",\s*"([^"\n]*)"(?:,\s*(\d+))?/g)){if(m[1].includes('\\('))continue;const pos=text.indexOf(definition)+m.index;add(m[1],m[2],Number(m[3]??0),'静态 entry',text.slice(0,pos).split('\n').length);}
// 明确展开上游源码中固定的循环；不把模板字符串当作一个已实现功能。
const tools=definition.slice(definition.indexOf('for (title, key)'),definition.indexOf('result += [entry("Decrease brush hardness"'));
for(const m of tools.matchAll(/\("([^"\n]+)",\s*"([^"\n]*)"\)/g))add(m[1],m[2],0,'工具/编辑操作固定列表',100);
for(let digit=0;digit<=9;digit++)add('Opacity digit '+digit+' (type two for exact %)',String(digit),0,'0...9 循环',113);
for(const [direction,key]of [['Left','\uF702'],['Right','\uF703'],['Up','\uF700'],['Down','\uF701']])for(const [title,bits]of [['Nudge '+direction+' 1 px',0],['Nudge '+direction+' 10 px',8],['Move selected pixels '+direction+' 1 px',1],['Move selected pixels '+direction+' 10 px',9]])add(title,key,bits,'方向键循环',114);
add('Finish editing text','\r',1,'文字编辑',118);
for(const [title,key]of [['Decrease tracking','\uF702'],['Increase tracking','\uF703'],['Decrease leading','\uF700'],['Increase leading','\uF701']]){add(title,key,2,'文字编辑循环',119);add(title+' by 10',key,10,'文字编辑循环',119);}
const menuNodes=[];
for(const [i,line]of app.split(/\r?\n/).entries()){const m=/\b(Button|Toggle)\((.+)/.exec(line);if(!m)continue;let label=m[2],end=label.indexOf(') {');if(end>=0)label=label.slice(0,end);else if(label.includes(', isOn:'))label=label.slice(0,label.indexOf(', isOn:'));else if(label.endsWith(')'))label=label.slice(0,-1);menuNodes.push({id:'NATIVE-MENU-'+String(menuNodes.length+1).padStart(3,'0'),control:m[1],expression:label,source:appSource,line:i+1,dynamic:!label.startsWith('"')||label.includes('\\(')});}
await saveJSON('catalog-upstream.json',{note:'菜单项是源码控件节点（包含动态标签/ForEach模板），不是运行时展开的菜单总数。快捷键已展开源码固定循环；用于逐条语义对照，不宣称运行了 macOS。',shortcuts,menuNodes});
console.log(JSON.stringify({nativeShortcutDefinitions:shortcuts.length,nativeMenuSourceNodes:menuNodes.length}));
