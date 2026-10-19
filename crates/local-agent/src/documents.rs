// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Documents are opened on the device. Only extracted content and page images
//! cross AgentRPC; neither a client path nor Office macros execute on the server.
use pdfium_render::prelude::*;
use serde_json::{Value, json};
use std::{fs, path::Path, sync::Mutex};
use tokio::sync::watch;

static PARSE_LOCK: Mutex<()> = Mutex::new(());
const PAGE_BYTES: usize = 64 * 1024;

fn page_text(text: &str, offset: u64) -> Result<Value, String> {
    let offset = usize::try_from(offset).map_err(|_| "DOCUMENT_OFFSET_INVALID")?;
    if offset > text.len() || !text.is_char_boundary(offset) {
        return Err("DOCUMENT_OFFSET_INVALID".into());
    }
    let mut end = text.len().min(offset.saturating_add(PAGE_BYTES));
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok(
        json!({"content":&text[offset..end],"offset":offset,"nextOffset":end,
        "contentBytes":text.len(),"truncated":end<text.len()}),
    )
}

fn parser_error(error: impl std::fmt::Display) -> String {
    let message = error.to_string();
    let lower = message.to_lowercase();
    let code = if lower.contains("password") || lower.contains("encrypt") {
        "DOCUMENT_PASSWORD_REQUIRED"
    } else {
        "DOCUMENT_PARSE_FAILED"
    };
    format!("{code}: {message}")
}

pub fn read(root: &Path, p: &Value, cancel: &watch::Receiver<bool>) -> Result<Value, String> {
    let path = super::workspace::resolve(root, super::required_string(p, "path")?)?;
    let before = super::attachments::stat(&path)?;
    if p["version"]
        .as_str()
        .is_some_and(|v| before["version"] != v)
    {
        return Err("SOURCE_CHANGED".into());
    }
    // Serialize parser initialization; cancellation remains observable while waiting.
    let _guard = loop {
        if *cancel.borrow() {
            return Err("DOCUMENT_CANCELLED".into());
        }
        match PARSE_LOCK.try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(_) => return Err("DOCUMENT_PARSER_UNAVAILABLE".into()),
        }
    };
    let section = p["section"].as_u64().unwrap_or(1);
    if section == 0 {
        return Err("DOCUMENT_SECTION_INVALID: sections start at 1".into());
    }
    let offset = p["offset"].as_u64().unwrap_or(0);
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mut result = if ext == "pdf" {
        let exe = std::env::current_exe().map_err(parser_error)?;
        let mut directory = exe.parent().ok_or("DOCUMENT_RUNTIME_MISSING")?;
        if cfg!(debug_assertions) && directory.file_name().is_some_and(|n| n == "deps") {
            directory = directory.parent().ok_or("DOCUMENT_RUNTIME_MISSING")?;
        }
        // Use only our bundled library, never an arbitrary DLL on PATH/cwd.
        let library = Pdfium::pdfium_platform_library_name_at_path(directory);
        let mac_resource =
            Pdfium::pdfium_platform_library_name_at_path(&directory.join("../Resources"));
        let binding = Pdfium::bind_to_library(if library.is_file() {
            library
        } else {
            mac_resource
        });
        let pdfium = match binding {
            Ok(binding) => Pdfium::new(binding),
            // pdfium-render 0.9 keeps bindings process-wide. In this branch its
            // default constructor reuses those verified bindings without loading
            // another DLL (including on the next page/next parser thread).
            Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => Pdfium::default(),
            Err(error) => return Err(format!("DOCUMENT_RUNTIME_MISSING: {error}")),
        };
        let pdf = pdfium
            .load_pdf_from_file(&path, None)
            .map_err(parser_error)?;
        let total = pdf.pages().len();
        if section > total as u64 {
            return Err("DOCUMENT_SECTION_INVALID".into());
        }
        let page = pdf
            .pages()
            .get((section - 1) as PdfPageIndex)
            .map_err(parser_error)?;
        let text = page.text().map_err(parser_error)?.all();
        let mut row = page_text(&text, offset)?;
        row["format"] = json!("pdf");
        row["sectionKind"] = json!("page");
        row["sections"] = json!(total);
        row["section"] = json!(section);
        row["nextSection"] = if section < total as u64 {
            json!(section + 1)
        } else {
            Value::Null
        };
        row["scanned"] = json!(text.trim().is_empty());
        // Empty text is not a successful reading of a scanned page. Supply its pixels.
        if p["render"] == true || text.trim().is_empty() {
            if *cancel.borrow() {
                return Err("DOCUMENT_CANCELLED".into());
            }
            let scale = p["scale"].as_f64().unwrap_or(2.0);
            if !scale.is_finite() || scale <= 0.0 || scale > f32::MAX as f64 {
                return Err("DOCUMENT_SCALE_INVALID".into());
            }
            let image = page
                .render_with_config(&PdfRenderConfig::new().scale_page_by_factor(scale as f32))
                .map_err(parser_error)?
                .as_image()
                .map_err(parser_error)?;
            let dir = std::env::temp_dir().join("codexia-attachments-v1");
            fs::create_dir_all(&dir).map_err(parser_error)?;
            let id = uuid::Uuid::new_v4().to_string();
            let name = format!("{id}.png");
            let file = dir.join(&name);
            image
                .save_with_format(&file, image::ImageFormat::Png)
                .map_err(parser_error)?;
            fs::write(dir.join(format!("{id}.registered")), name).map_err(parser_error)?;
            row["image"] = super::attachments::stat(&file)?;
        }
        row
    } else {
        // No product-level document/row/slide quotas. Reading is paginated below.
        office_oxide::limits::set_max_text_chars(usize::MAX);
        office_oxide::limits::set_max_package_entries(usize::MAX);
        office_oxide::limits::set_max_package_bytes(u64::MAX);
        let document = office_oxide::Document::open(&path).map_err(parser_error)?;
        let mut ir = document.to_ir();
        let total = ir.sections.len();
        if section as usize > total {
            return Err("DOCUMENT_SECTION_INVALID".into());
        }
        let selected = ir.sections.remove(section as usize - 1);
        let title = selected.title.clone();
        let hidden = selected.hidden;
        ir.sections = vec![selected];
        let text = ir.to_markdown();
        let mut row = page_text(&text, offset)?;
        row["format"] = json!(ext);
        row["section"] = json!(section);
        row["sections"] = json!(total);
        row["title"] = json!(title);
        row["hidden"] = json!(hidden);
        row["sectionKind"] = json!(match ext.as_str() {
            "xls" | "xlsx" | "xlsm" => "worksheet",
            "ppt" | "pptx" | "pptm" => "slide",
            _ => "section",
        });
        row["nextSection"] = if section < total as u64 {
            json!(section + 1)
        } else {
            Value::Null
        };
        row["representation"] = json!(
            "extracted-markdown; formulas are not recalculated; document macros and external links are not executed"
        );
        row
    };
    if *cancel.borrow() {
        return Err("DOCUMENT_CANCELLED".into());
    }
    if super::attachments::stat(&path)?["version"] != before["version"] {
        return Err("SOURCE_CHANGED".into());
    }
    result["source"] = json!("client");
    result["path"] = before["path"].clone();
    result["version"] = before["version"].clone();
    result["untrusted"] = json!(true);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_pages_have_no_gaps() {
        let text = "a".repeat(PAGE_BYTES - 1) + "你好";
        let first = page_text(&text, 0).unwrap();
        let second = page_text(&text, first["nextOffset"].as_u64().unwrap()).unwrap();
        assert_eq!(
            format!(
                "{}{}",
                first["content"].as_str().unwrap(),
                second["content"].as_str().unwrap()
            ),
            text
        );
        assert_eq!(second["truncated"], false);
    }
}
