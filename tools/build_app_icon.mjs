// Vector artwork and pixel-aligned Windows icon sizes; no external artwork.
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out=fileURLToPath(new URL('../assets/',import.meta.url));
const rows=['.....r.....','....rrr....','.r..rrr..r.','.rr.rrr.rr.','.rrrrrrrrr.','rrrrrrrrrrr','.rrrrrrrrr.','..rrrrrrr..','.rr.rkr.rr.','.....k.....','....k......'];
function artwork(size){
 const cell=Math.max(1,Math.floor(size/16)),left=Math.floor((size-cell*11)/2),top=Math.floor((size-cell*11)/2);
 const leaf=rows.flatMap((r,y)=>[...r].flatMap((c,x)=>c==='.'?[]:[`<rect x="${left+x*cell}" y="${top+y*cell}" width="${cell}" height="${cell}" fill="${c==='r'?'#ed5545':'#f3e7c9'}"/>`])).join('');
 const line=size>=64?`<rect x="${size*.065}" y="${size*.065}" width="${size*.87}" height="${size*.87}" rx="${size*.16}" fill="none" stroke="#405c7e" stroke-width="${size/128}"/>`:'';
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><title>枫叶市集</title><rect width="${size}" height="${size}" rx="${size*.21}" fill="#222e3e"/>${line}<g shape-rendering="crispEdges">${leaf}</g></svg>`;
}
await mkdir(out,{recursive:true});
await writeFile(path.join(out,'app-icon.svg'),artwork(256));
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
const sizes=[16,24,32,48,64,128,256],frames=[];
try{
 for(const size of [...sizes,512]){
  const page=await browser.newPage({viewport:{width:size,height:size},deviceScaleFactor:1});
  await page.setContent(`<style>body{margin:0;background:transparent}</style>${artwork(size)}`);
  const png=await page.screenshot({omitBackground:true});
  if(size===512)await writeFile(path.join(out,'app-icon.png'),png);else frames.push(png);
  await page.close();
 }
}finally{await browser.close();}
const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
let offset=header.length;
sizes.forEach((size,i)=>{const at=6+i*16;header[at]=header[at+1]=size===256?0:size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(frames[i].length,at+8);header.writeUInt32LE(offset,at+12);offset+=frames[i].length;});
await writeFile(path.join(out,'app-icon.ico'),Buffer.concat([header,...frames]));
console.log(`Built SVG, PNG and ICO (${sizes.join(', ')} px).`);
