// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useId, useState } from "react";
import { t, useLocale } from "./i18n";

interface Question { id: string; header?: string; question: string; options?: {label:string;description?:string}[]; isSecret?: boolean }
export function inputQuestions(params: unknown): Question[] | undefined {
  const rows = (params as {questions?: unknown} | null)?.questions;
  if (!Array.isArray(rows) || !rows.length || rows.length > 3) return;
  const ids = new Set<string>();
  for (const q of rows) {
    if (!q || typeof q.id !== "string" || !q.id || ids.has(q.id) || typeof q.question !== "string"
      || (q.options != null && (!Array.isArray(q.options) || q.options.some((o: {label?:unknown}) => !o || typeof o.label !== "string")))) return;
    ids.add(q.id);
  }
  return rows;
}
export function UserInputQuestions({params, disabled, submit}: {params:unknown;disabled:boolean;submit:(response:unknown)=>void}) {
  useLocale();
  const prefix = useId(), questions = inputQuestions(params);
  const [answers,setAnswers] = useState<Record<string,string>>({});
  if (!questions) return <div role="alert">{t("问题格式不兼容，请停止本轮后重试。")}</div>;
  return <form className="user-input-questions" onSubmit={event=>{
    event.preventDefault();
    submit({answers:Object.fromEntries(questions.map(q=>[q.id,{answers:answers[q.id]?.trim() ? [answers[q.id].trim()] : []}]))});
  }}>
    {questions.map(q=><fieldset key={q.id} disabled={disabled}>
      <legend>{q.question}</legend>
      {q.options?.map((option,index)=><label className="question-option" key={index}>
        <input type="radio" name={`${prefix}-${q.id}`} checked={answers[q.id]===option.label} onChange={()=>setAnswers(a=>({...a,[q.id]:option.label}))}/>
        <span>{option.label}{option.description&&<small>{option.description}</small>}</span>
      </label>)}
      <label className="question-custom">{t("补充回答")}
        <input type={q.isSecret ? "password" : "text"} autoComplete="off" value={answers[q.id]??""} onChange={event=>setAnswers(a=>({...a,[q.id]:event.target.value}))}/>
      </label>
    </fieldset>)}
    <div className="button-row"><button type="submit" disabled={disabled}>{t("提交回答")}</button>
      <button type="button" className="button-secondary" disabled={disabled} onClick={()=>submit({answers:{}})}>{t("跳过问题")}</button></div>
  </form>;
}
