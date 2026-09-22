// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownMessage } from '../../apps/desktop/src/MarkdownMessage';
import { DiffView } from '../../apps/desktop/src/DiffView';
import { ExecutionLog } from '../../apps/desktop/src/ExecutionLog';
import { OutputCard } from '../../apps/desktop/src/outputs';
import { MessageAttachments } from '../../apps/desktop/src/attachments';
import '../../apps/desktop/src/styles.css';
const sampleDiff = 'diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1,2 +1,2 @@\n-const value = 1;\n+const value = 2;\n export { value };\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+新文件';
function Fixture() {
  const [state, setState] = useState<any>({content:'```json\n{"name":"远舟","items":[1,true,null,{"nested":"内容"}]}\n```',diff:sampleDiff,logs:[{sequence:1,stream:'stdout',chunk:'开始处理\n'},{sequence:2,stream:'stderr',chunk:'错误示例\n'},{sequence:3,stream:'progress',chunk:'完成 50%\n'}],attachments:[],outputs:[]});
  (window as any).setResults = (next:any) => setState((previous:any) => ({...previous,...next}));
  return <main className="result-fixture" style={{width:'100%',maxWidth:800,margin:'auto',padding:16,boxSizing:'border-box'}}><h1>回复结果展示</h1><section id="json"><MarkdownMessage content={state.content} streaming={state.streaming}/></section><section id="diff"><DiffView text={state.diff} truncated={state.truncated}/></section><section id="logs"><ExecutionLog logs={state.logs}/></section><section id="files"><MessageAttachments attachments={state.attachments}/>{state.outputs.map((output:any)=><OutputCard key={output.id} output={output} retry={async()=>{(window as any).retried=true;}}/>)}</section><section id="image"><MarkdownMessage content={state.image||''} images={state.images||[]}/></section></main>;
}
document.documentElement.dataset.theme='light';document.body.style.overflow='auto';document.body.style.height='auto';document.body.style.background='var(--canvas)';
createRoot(document.getElementById('root')!).render(<Fixture/>);
