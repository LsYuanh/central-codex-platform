// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Offline, first account only. Credentials arrive through stdin, never argv/environment.
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {PlatformAuth} from '../services/test-gateway/dist/platform-auth.js';
const path=process.env.PLATFORM_AUTH_FILE;
if(!path||existsSync(resolve(path)))throw Error('Set a NEW PLATFORM_AUTH_FILE; existing stores must be managed through authenticated admin APIs');
let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>4096)throw Error('Input too large');}
const input=JSON.parse(raw);const store=new PlatformAuth(resolve(path));
try{const user=await store.createUser(input.username,input.password,'admin');console.log(JSON.stringify({ok:true,user}));}finally{store.close();}
