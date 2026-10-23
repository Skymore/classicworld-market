import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../js/lib/item-preview.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
const {previewPosition,previewItem}=await import('data:text/javascript,'+encodeURIComponent(source));
test('preview sits beside a row and flips away from the viewport edge',()=>{
  assert.deepEqual(previewPosition({left:100,right:300,top:100},{width:320,height:400},{width:1200,height:800}),{left:312,top:100});
  assert.deepEqual(previewPosition({left:800,right:1000,top:600},{width:320,height:400},{width:1200,height:800}),{left:468,top:388});
  assert.deepEqual(previewPosition({left:24,right:1176,top:100},{width:320,height:400},{width:1200,height:800}),{left:336,top:100});
});
test('preview stays within the visible viewport on small screens',()=>{
  assert.deepEqual(previewPosition({left:0,right:350,top:-50},{width:326,height:500},{width:350,height:600}),{left:12,top:12});
});
function target(href,{row=false,open='1462004',inside=false}={}){
  const anchor={href,dataset:{open},matches:()=>row,closest:()=>inside?{}:null};
  return {closest:()=>anchor};
}
test('only same-origin item links and item rows qualify for preview',()=>{
  assert.equal(previewItem(target('https://mxd.ruit.me/item/1462004?hours=all'),'https://mxd.ruit.me').id,1462004);
  assert.equal(previewItem(target('https://other.example/item/1462004'),'https://mxd.ruit.me'),null);
  assert.equal(previewItem(target('https://mxd.ruit.me/mob/1462004'),'https://mxd.ruit.me'),null);
  assert.equal(previewItem(target('http://['),'https://mxd.ruit.me'),null);
  assert.equal(previewItem(target('',{row:true}),'https://mxd.ruit.me').id,1462004);
  assert.equal(previewItem(target('',{row:true,open:'<script>'}),'https://mxd.ruit.me'),null);
  assert.equal(previewItem(target('https://mxd.ruit.me/item/1462004',{inside:true}),'https://mxd.ruit.me'),null);
});
