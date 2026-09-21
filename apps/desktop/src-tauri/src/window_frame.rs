// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

#[cfg(any(windows, test))]
fn caption_color(color: &str) -> Result<u32, String> {
    let hex = color.strip_prefix('#').ok_or("标题栏颜色必须为 #RRGGBB")?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("标题栏颜色必须为 #RRGGBB".into());
    }
    let rgb = u32::from_str_radix(hex, 16).map_err(|error| error.to_string())?;
    // Windows COLORREF stores the red channel in the least significant byte.
    Ok((rgb & 0xff) << 16 | (rgb & 0xff00) | (rgb >> 16))
}

#[tauri::command]
pub fn set_window_caption_color(window: tauri::Window, color: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Dwm::{DWMWA_CAPTION_COLOR, DwmSetWindowAttribute};
        let color = caption_color(&color)?;
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        // This per-window attribute survives focus changes. Native caption buttons,
        // text, dragging and accessibility remain managed by Windows.
        // SAFETY: hwnd belongs to the calling Tauri window; color is a live COLORREF
        // and the supplied buffer size matches its type for this synchronous call.
        let result = unsafe {
            DwmSetWindowAttribute(
                hwnd.0,
                DWMWA_CAPTION_COLOR as u32,
                (&color as *const u32).cast(),
                std::mem::size_of::<u32>() as u32,
            )
        };
        // Windows versions before 11 do not support explicit caption colors.
        // Leave their native light/dark appearance intact.
        if result < 0 && result != windows_sys::Win32::Foundation::E_INVALIDARG {
            return Err(format!("设置标题栏颜色失败：0x{:08X}", result as u32));
        }
    }
    #[cfg(not(windows))]
    let _ = (window, color);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::caption_color;

    #[test]
    fn converts_css_rgb_to_windows_colorref() {
        assert_eq!(caption_color("#edf3f8").unwrap(), 0x00f8f3ed);
        assert_eq!(caption_color("#20262e").unwrap(), 0x002e2620);
        for invalid in ["", "#fff", "#12345678", "#gggggg", "rgb(1,2,3)"] {
            assert!(caption_color(invalid).is_err());
        }
    }
}
