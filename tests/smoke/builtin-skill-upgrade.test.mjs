// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SkillStore,skillScope} from '../../services/central-gateway/dist/skills.js';
import {CREATOR_ID} from '../../services/central-gateway/dist/builtin-creator.js';

for(const preferenceRevision of [0,7]) {
  test(`existing v2 creator projection upgrades without overwriting history (preference ${preferenceRevision})`,()=>{
    const root=realpathSync(mkdtempSync(join(tmpdir(),'yz-skill-upgrade-'))),user='upgrade-user';
    const file=join(root,'skills.json'),automatic=preferenceRevision===0;
    writeFileSync(file,JSON.stringify({version:1,skills:[],drafts:[],builtinPreferences:{[skillScope(user)]:{automatic,revision:preferenceRevision}}}));
    const oldVersion=`${CREATOR_ID}/${2_000_000+preferenceRevision}`;
    const old=join(root,'managed-skills',oldVersion);
    mkdirSync(join(old,'agents'),{recursive:true});
    const oldContent='---\nname: yuan-zhou-skill-creator\ndescription: "previous release"\n---\n最多 64 个文件、共 8 MiB。\n';
    writeFileSync(join(old,'SKILL.md'),oldContent);
    writeFileSync(join(old,'agents/openai.yaml'),`policy:\n  allow_implicit_invocation: ${automatic}\n`);
    const store=new SkillStore(file);
    store.project(user,root);
    const current=store.get(user,CREATOR_ID),target=store.nativePath(root,current);
    assert.notEqual(current.revision,2_000_000+preferenceRevision);
    assert.equal(current.automatic,automatic);
    assert.equal(readFileSync(join(old,'SKILL.md'),'utf8'),oldContent);
    assert.deepEqual(JSON.parse(readFileSync(join(root,'managed-skills/catalog.json'))),[`${CREATOR_ID}/${current.revision}`]);
    assert.doesNotMatch(readFileSync(target,'utf8'),/最多 64 个文件/);
    assert.doesNotThrow(()=>store.project(user,root));
    // A release bump must not weaken the existing projection-integrity guard.
    writeFileSync(target,'tampered current projection');
    assert.throws(()=>store.project(user,root),/SKILL_PROJECTION_CHANGED/);
  });
}
