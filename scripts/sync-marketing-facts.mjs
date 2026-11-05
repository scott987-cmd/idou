// Validate the static page against the marketing fact manifest; no writes outside this site.
import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const site=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const facts=JSON.parse(readFileSync(path.join(site,'marketing-facts.json'),'utf8'));
const html=readFileSync(path.join(site,'index.html'),'utf8');
const required=[facts.release.id, facts.release.strictGatePassed.toLocaleString('en-US'), '2 项 Linux', '企业问答','个人助理','仍待部署'];
for(const word of required) if(!html.includes(word)) throw new Error(`Missing fact: ${word}`);
for(const stale of ['3,067 / 3,067','0.1.0-20261010.295','全面超越','登录即用']) if(html.includes(stale)) throw new Error(`Stale claim: ${stale}`);
for(const m of html.matchAll(/(?:src|poster|href)="(media\/[^"#?]+)"/g)) if(!existsSync(path.join(site,m[1]))) throw new Error(`Missing asset: ${m[1]}`);
console.log(`marketing page checked: ${facts.release.id}`);
