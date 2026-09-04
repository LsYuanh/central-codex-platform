// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import assert from "node:assert/strict";
import { messagesFromThreadRead } from "../apps/desktop/src/thread-history.ts";

const restored = messagesFromThreadRead({
  thread: {
    id: "thread_test",
    turns: [{
      id: "turn_1",
      items: [
        { type: "userMessage", content: [{ type: "inputText", text: "之前的问题" }] },
        { type: "agentMessage", text: "之前的回答" },
        { item: { type: "assistant", message: { content: [{ type: "outputText", text: "嵌套回答" }] } } },
      ],
    }],
  },
});

assert.deepEqual(restored.map(({ role, content }) => ({ role, content })), [
  { role: "user", content: "之前的问题" },
  { role: "assistant", content: "之前的回答" },
  { role: "assistant", content: "嵌套回答" },
]);

console.log("Thread history smoke passed: user, agent and nested history items restored");

const attached = messagesFromThreadRead({thread:{turns:[{id:"turn-image",items:[{type:"userMessage",content:[{type:"text",text:"[platform-message:message-image] internal manifest"},{type:"image"}]},{type:"agentMessage",text:"red and blue"}]}]},attachmentSubmissions:[{clientMessageId:"message-image",turnId:"turn-image",content:"",status:"sent",attachments:[{id:"image-1",name:"two-colors.png",deviceId:"original-device",path:"C:\\outside\\two-colors.png",kind:"image",state:"read"}]}]});
assert.equal(attached[0].content, "");
assert.equal(attached[0].id, "message-image");
assert.equal(attached[0].attachments?.[0].deviceId, "original-device");
assert.equal(attached[0].attachments?.[0].name, "two-colors.png");
assert.equal(attached.length, 2);
console.log("Attachment history smoke passed: image-only message retains card and original device without exposing manifest");

const output={id:"image-result",threadId:"t",turnId:"generated-turn",deviceId:"client",source:"generatedImage",kind:"image",name:"generated.png",path:"C:\\Downloads\\Codexia\\generated.png",status:"saved"};
const generated=messagesFromThreadRead({thread:{turns:[{id:"generated-turn",items:[{type:"imageGeneration",id:"image-result",result:"DO_NOT_RENDER_BASE64"},{type:"agentMessage",text:"已保存"}]}]},outputs:[output]});
assert.equal(generated[0].outputs?.[0].path,output.path);
assert.equal(generated[0].role,"assistant");
assert.equal(generated[0].content,"");
assert.equal(generated.filter(m=>m.outputs?.length).length,1);
assert(!JSON.stringify(generated).includes("DO_NOT_RENDER_BASE64"));
console.log("Output history smoke passed: generated image restored once as a client output card");
