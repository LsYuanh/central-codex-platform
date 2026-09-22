// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
const paths = {
  panel: "M3 3h18v18H3zM9 3v18",
  edit: "m15 4 5 5M4 20l5-1L21 7l-5-5L4 14z",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14M15 15l6 6",
  settings: "M8.96 5.23Q9.43 4.95 9.53 4.41L9.82 2.76Q9.92 2.22 10.47 2.22H13.53Q14.08 2.22 14.18 2.76L14.47 4.41Q14.57 4.95 15.04 5.23L16.34 5.98Q16.82 6.25 17.34 6.07L18.91 5.5Q19.43 5.31 19.71 5.79L21.24 8.43Q21.51 8.91 21.09 9.26L19.81 10.34Q19.39 10.7 19.39 11.25V12.75Q19.39 13.3 19.81 13.66L21.09 14.74Q21.51 15.09 21.24 15.57L19.71 18.21Q19.43 18.69 18.91 18.5L17.34 17.93Q16.82 17.75 16.34 18.02L15.04 18.77Q14.57 19.05 14.47 19.59L14.18 21.24Q14.08 21.78 13.53 21.78H10.47Q9.92 21.78 9.82 21.24L9.53 19.59Q9.43 19.05 8.96 18.77L7.66 18.02Q7.18 17.75 6.66 17.93L5.09 18.5Q4.57 18.69 4.29 18.21L2.76 15.57Q2.49 15.09 2.91 14.74L4.19 13.66Q4.61 13.3 4.61 12.75V11.25Q4.61 10.7 4.19 10.34L2.91 9.26Q2.49 8.91 2.76 8.43L4.29 5.79Q4.57 5.31 5.09 5.5L6.66 6.07Q7.18 6.25 7.66 5.98ZM12 8.75a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5Z",
  sliders: "M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10M7 4v4h4V4H7Zm6 6v4h4v-4h-4ZM7 16v4h4v-4H7Z",
  update: "M12 16V3m-5 5 5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3",
  folder: "M3 6h7l2 3h9v11H3zM3 6V4h6l2 2h9v3",
  folderOpen: "M3 19V5h6l2 3h8v3M3 19l3-8h16l-3 8z",
  folderPlus: "M3 6h7l2 3h9v5M3 6V4h6l2 2h9v3M3 6v14h9M18 16v6M15 19h6",
  refresh: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1",
  chat: "M6 4h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9l-6 3V7a3 3 0 0 1 3-3ZM7 9h10M7 13h7",
  plus: "M12 5v14M5 12h14",
  pin: "m9 3 12 12-3 1-3-3-5 5-4-4 5-5-3-3zM8 16l-5 5",
  file: "M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6",
  terminal: "m5 7 5 5-5 5M13 17h6",
  arrow: "M21 12H3m7-7-7 7 7 7",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  review: "M8 4v16M16 4v7a5 5 0 0 1-5 5H8M5 4h6M5 20h6M13 4h6",
  skill: "m12 3 9 5v8l-9 5-9-5V8l9-5ZM3 8l9 5 9-5M12 13v8",
  build: "m4 20 10-10m-2-6 3-2 7 7-2 3-4-4-3 3-4-4z",
  bug: "M8 8h8v8a4 4 0 0 1-8 0zM9 8V5h6v3M4 10h4M16 10h4M4 15h4M16 15h4M6 21l3-3M15 18l3 3",
  close: "m6 6 12 12M6 18 18 6",
  monitor: "M3 3h18v14H3zM12 17v4M8 21h8",
  server: "M4 3h16v8H4zM4 13h16v8H4zM7 7h1M7 17h1M11 7h6M11 17h6",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5",
  moon: "M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z",
  check: "m5 12 4 4L19 6",
  chevronDown: "m6 9 6 6 6-6",
  arrowDown: "M12 4v16m-7-7 7 7 7-7",
  archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
} as const;

export function UiIcon({ name }: { name: keyof typeof paths | "more" }) {
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">{name === "more"
    ? [5, 12, 19].map(cx => <circle key={cx} cx={cx} cy="12" r="1.5" fill="currentColor" stroke="none" />)
    : <path d={paths[name]} />}</svg>;
}
