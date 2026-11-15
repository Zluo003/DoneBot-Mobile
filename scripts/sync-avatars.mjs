import {readFile,writeFile,mkdir,copyFile,cp,readdir} from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname, '..'), desktop=resolve(root, '../DoneBot');
const dest=`${root}/src/desktop/avatar`;
await mkdir(dest,{recursive:true});
for(const name of ['CursorAvatar.tsx','cursor-face-data.ts','mascot-motion.ts','mascot-clock.ts','CarvedAvatar.tsx']) {
 let s=await readFile(`${desktop}/src/components/${name}`,'utf8');
 s=s.replaceAll('../../shared/','./').replaceAll('@/lib/mascot','./palette');
 s=s.replace('import { mascotLabel } from "./palette-names"','import { mascotLabel } from "./labels"');
 await writeFile(`${dest}/${name}`,`// Copyright OpenMausBot contributors. Apache-2.0; see third_party/OpenMausBot-LICENSE.\n${s}`);
}
for(const name of ['mascot-bodies.ts','carved-bodies.ts','bot-avatar.ts']) await copyFile(`${desktop}/shared/${name}`,`${dest}/${name}`);
let mascot=await readFile(`${desktop}/src/lib/mascot.ts`,'utf8');
const expressionStart=mascot.indexOf('const LEGACY_STATES:'), expressionEnd=mascot.indexOf('export const PICKABLE_STATES');
if(expressionStart<0 || expressionEnd<=expressionStart) throw new Error('Missing desktop expression contract');
await writeFile(`${dest}/expression.ts`, `// Copyright OpenMausBot contributors. Apache-2.0; see third_party/OpenMausBot-LICENSE.\nimport { CURSOR_STATES, type CursorState } from './CursorAvatar';\nimport { mascotExpressionSchema } from './bot-avatar';\ntype MausState = CursorState;\n${mascot.slice(expressionStart,expressionEnd).replace('new Set<string>(MAUS_STATES)','new Set<string>(CURSOR_STATES)').replace('const LEGACY_STATES: LegacyStates','const LEGACY_STATES: Record<string, MausState>').trimEnd()}\n`);
await writeFile(`${dest}/palette.ts`,`${mascot.slice(mascot.indexOf('export const MAUS_COLORS ='),mascot.indexOf('export const MAUS_COLOR_LABEL'))}\n${mascot.slice(mascot.indexOf('export const CHROME_GRADIENT'),mascot.indexOf('export function colorSwatch'))}\nexport type MausColor = keyof typeof MAUS_COLORS;\nexport type MausState = import('./CursorAvatar').CursorState;\nexport type MausMotion = "none" | "arrive" | "switch" | "customize" | "alert" | "thinking" | "working" | "launch" | "success" | "celebrate" | "blink" | "surprise" | "failure";\n`.replace('satisfies Record<MausColor, string>',''));
await writeFile(`${dest}/labels.ts`,'export const mascotLabel = (value: string): string => value;\n');
await mkdir(`${root}/public/mascot-steel`,{recursive:true});
await cp(`${desktop}/src/assets/mausbot-steel`,`${root}/public/mascot-steel`,{recursive:true});

await writeFile(`${dest}/steel-images.json`, JSON.stringify((await readdir(`${root}/public/mascot-steel`)).filter(name => name.endsWith(".webp")), null, 2)+"\n");
