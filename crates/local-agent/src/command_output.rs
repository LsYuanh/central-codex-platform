// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Command streams may use the Windows console code page; file contents keep
// their existing UTF-8 contract. Bound both source bytes and returned UTF-8 bytes.
pub struct DecodedOutput {
    pub text: String,
    pub truncated: bool,
}

pub fn decode(bytes: &[u8], limit: usize) -> DecodedOutput {
    #[cfg(windows)]
    let code_page = unsafe { windows_sys::Win32::Globalization::GetOEMCP() };
    #[cfg(not(windows))]
    let code_page = 65001;
    decode_with_code_page(bytes, limit, code_page)
}

/// Return a prefix that can be decoded now without cutting a UTF-8 scalar or,
/// on Windows, a trailing byte from the active OEM double-byte code page.
/// The caller retains the suffix for the next pipe read.
pub fn complete_stream_prefix_len(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(_) => {
            #[cfg(windows)]
            {
                let code_page = unsafe { windows_sys::Win32::Globalization::GetOEMCP() };
                if unsafe {
                    windows_sys::Win32::Globalization::IsDBCSLeadByteEx(
                        code_page,
                        *bytes.last().unwrap(),
                    )
                } != 0
                {
                    return bytes.len() - 1;
                }
            }
            bytes.len()
        }
    }
}

fn decode_with_code_page(bytes: &[u8], limit: usize, code_page: u32) -> DecodedOutput {
    let end = bytes.len().min(limit);
    let source_truncated = end < bytes.len();
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little_endian = bytes[0] == 0xff;
        let content = bytes.get(2..end).unwrap_or_default();
        let mut units: Vec<u16> = content
            .chunks_exact(2)
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        if source_truncated
            && units
                .last()
                .is_some_and(|unit| (0xd800..=0xdbff).contains(unit))
        {
            units.pop();
        }
        let mut text = String::from_utf16_lossy(&units);
        if !source_truncated && content.len() % 2 != 0 {
            text.push('\u{fffd}');
        }
        text
    } else {
        let offset = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            3
        } else {
            0
        };
        let content = bytes.get(offset..).unwrap_or_default();
        let budget = limit.saturating_sub(offset);
        // Look past the cutoff only far enough to validate a straddling UTF-8
        // scalar. Invalid bytes later in a large stream cannot change this prefix.
        let probe = &content[..content.len().min(budget.saturating_add(3))];
        let utf8 = match std::str::from_utf8(probe) {
            Ok(text) => Some(text),
            Err(error) if error.valid_up_to() >= budget => {
                std::str::from_utf8(&probe[..error.valid_up_to()]).ok()
            }
            Err(_) => None,
        };
        if let Some(text) = utf8 {
            let mut end = text.len().min(budget);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text[..end].to_owned()
        } else {
            let prefix = &content[..content.len().min(budget)];
            (offset == 0)
                .then(|| native_text(prefix, code_page, source_truncated))
                .flatten()
                .unwrap_or_else(|| String::from_utf8_lossy(prefix).into_owned())
        }
    };
    let mut output = DecodedOutput {
        truncated: source_truncated || text.len() > limit,
        text,
    };
    let mut end = output.text.len().min(limit);
    while !output.text.is_char_boundary(end) {
        end -= 1;
    }
    output.text.truncate(end);
    output
}

#[cfg(not(windows))]
fn native_text(_: &[u8], _: u32, _: bool) -> Option<String> {
    None
}

#[cfg(windows)]
fn native_text(bytes: &[u8], code_page: u32, truncated: bool) -> Option<String> {
    use windows_sys::Win32::Globalization::{
        IsDBCSLeadByteEx, MB_ERR_INVALID_CHARS, MultiByteToWideChar,
    };
    fn convert(bytes: &[u8], code_page: u32) -> Option<String> {
        if bytes.is_empty() {
            return Some(String::new());
        }
        let length = i32::try_from(bytes.len()).ok()?;
        // The input is bounded and length-delimited. The second conversion uses
        // exactly the UTF-16 buffer length returned by the first call.
        let size = unsafe {
            MultiByteToWideChar(
                code_page,
                MB_ERR_INVALID_CHARS,
                bytes.as_ptr(),
                length,
                std::ptr::null_mut(),
                0,
            )
        };
        if size == 0 {
            return None;
        }
        let mut wide = vec![0u16; size as usize];
        let written = unsafe {
            MultiByteToWideChar(
                code_page,
                MB_ERR_INVALID_CHARS,
                bytes.as_ptr(),
                length,
                wide.as_mut_ptr(),
                size,
            )
        };
        if written != size {
            return None;
        }
        String::from_utf16(&wide).ok()
    }
    convert(bytes, code_page).or_else(|| {
        let last = *bytes.last()?;
        if truncated && unsafe { IsDBCSLeadByteEx(code_page, last) } != 0 {
            convert(&bytes[..bytes.len() - 1], code_page)
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_utf8_and_does_not_split_chinese_or_emoji() {
        let text = "中文🙂";
        assert_eq!(decode_with_code_page(text.as_bytes(), 64, 936).text, text);
        let shortened = decode_with_code_page(text.as_bytes(), 8, 936);
        assert_eq!(shortened.text, "中文");
        assert!(shortened.truncated);
        assert_eq!(decode_with_code_page(text.as_bytes(), 2, 936).text, "");
        assert_eq!(decode(b"\xef\xbb\xbfhello", 64).text, "hello");
    }

    #[test]
    fn decodes_utf16_boms_without_splitting_surrogate_pairs() {
        for little_endian in [true, false] {
            let mut bytes = if little_endian {
                vec![0xff, 0xfe]
            } else {
                vec![0xfe, 0xff]
            };
            for unit in "中🙂".encode_utf16() {
                bytes.extend(if little_endian {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
            assert_eq!(decode(&bytes, 64).text, "中🙂");
            assert_eq!(decode(&bytes, 6).text, "中");
        }
    }

    #[test]
    fn ignores_bad_bytes_past_the_visible_prefix() {
        let bytes = ["中文".as_bytes(), &[0xff]].concat();
        assert_eq!(decode_with_code_page(&bytes, 6, 936).text, "中文");
    }

    #[cfg(windows)]
    #[test]
    fn decodes_gbk_and_bounds_expansion_and_dbcs_cutoffs() {
        let bytes = b"\xd6\xd0\xce\xc4"; // 中文 in CP936
        assert_eq!(decode_with_code_page(bytes, 64, 936).text, "中文");
        let expanded = decode_with_code_page(bytes, 4, 936);
        assert_eq!(expanded.text, "中");
        assert!(expanded.truncated);
        assert_eq!(decode_with_code_page(bytes, 3, 936).text, "中");
        assert_eq!(decode_with_code_page(bytes, 1, 936).text, "");
    }
}
