#!/usr/bin/env node
'use strict';
const fs=require('fs');
const files=['public/index.html','public/director.html','public/live.html'];
const tag='<link rel="stylesheet" href="/ui-light.css">';
for(const file of files){
  if(!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  let s=fs.readFileSync(file,'utf8');
  if(!fs.existsSync(file+'.bak')) fs.copyFileSync(file,file+'.bak');
  s=s.replace(/<meta name="theme-color" content="[^"]*">/i,'<meta name="theme-color" content="#f5f2eb">');
  if(!s.includes('/ui-light.css')){
    const i=s.lastIndexOf('</style>');
    if(i<0) throw new Error(`No </style> in ${file}`);
    s=s.slice(0,i+8)+'\n'+tag+s.slice(i+8);
  }
  fs.writeFileSync(file,s,'utf8');
  console.log('Patched',file);
}
console.log('Done. Backups saved as *.bak');
