import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.woff2':'font/woff2','.mp3':'audio/mpeg'};
export function staticServer(siteRoot) {
  const root=resolve(siteRoot);
  return createServer(async(req,res)=>{
    try {
      const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(path.startsWith('/api/')){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"preview_backend_unavailable"}');return;}
      let file=resolve(root,'.'+path);
      if(file!==root&&!file.startsWith(root+'/')){res.writeHead(403);res.end();return;}
      try{if((await stat(file)).isDirectory())file+='/index.html';await stat(file);}catch{if(!path.startsWith('/apps/')&&!extname(path))file=root+'/index.html';else{res.writeHead(404);res.end();return;}}
      const canonical=await realpath(file);
      if(!canonical.startsWith((await realpath(root))+'/')){res.writeHead(403);res.end();return;}
      res.setHeader('Content-Type',types[extname(file)]||'application/octet-stream');res.end(await readFile(file));
    }catch{res.writeHead(500);res.end();}
  });
}
