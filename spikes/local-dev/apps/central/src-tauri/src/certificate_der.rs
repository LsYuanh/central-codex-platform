// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Bounded DER extraction of validity and CA constraints. Rustls separately
//! verifies the certificate chain, names, signatures, usage and private key.
use super::{Result, failure};
use der::{
    Decode, Reader, Tag, Tagged,
    asn1::{AnyRef, BitStringRef, GeneralizedTime, UtcTime},
};

fn fields(value: AnyRef<'_>) -> Result<Vec<AnyRef<'_>>> {
    value
        .sequence(|reader| {
            let mut result = Vec::new();
            while !reader.is_finished() {
                if result.len() >= 128 {
                    return Err(reader.error(der::ErrorKind::Failed));
                }
                result.push(AnyRef::decode(reader)?);
            }
            Ok(result)
        })
        .map_err(|_| failure("TLS_FORMAT_INVALID"))
}
fn decoded(bytes: &[u8]) -> Result<AnyRef<'_>> {
    AnyRef::from_der(bytes).map_err(|_| failure("TLS_FORMAT_INVALID"))
}
fn millis(value: AnyRef<'_>) -> Result<u64> {
    let duration = match value.tag() {
        Tag::UtcTime => value.decode_as::<UtcTime>().map(|v| v.to_unix_duration()),
        Tag::GeneralizedTime => value
            .decode_as::<GeneralizedTime>()
            .map(|v| v.to_unix_duration()),
        _ => return Err(failure("TLS_FORMAT_INVALID")),
    }
    .map_err(|_| failure("TLS_FORMAT_INVALID"))?;
    u64::try_from(duration.as_millis()).map_err(|_| failure("TLS_CERTIFICATE_TIME_INVALID"))
}
pub(super) fn expiry(bytes: &[u8], checked_at: u64, require_ca: bool) -> Result<u64> {
    if bytes.len() > 256 * 1024 {
        return Err(failure("TLS_FORMAT_INVALID"));
    }
    let cert = fields(decoded(bytes)?)?;
    if cert.len() != 3 {
        return Err(failure("TLS_FORMAT_INVALID"));
    }
    let tbs = fields(cert[0])?;
    let version =
        usize::from(tbs.first().is_some_and(
            |v| matches!(v.tag(),Tag::ContextSpecific{number,..} if number.value()==0),
        ));
    if tbs.len() < version + 6 {
        return Err(failure("TLS_FORMAT_INVALID"));
    }
    let validity = fields(tbs[version + 3])?;
    if validity.len() != 2 {
        return Err(failure("TLS_FORMAT_INVALID"));
    }
    let before = millis(validity[0])?;
    let after = millis(validity[1])?;
    if checked_at < before || checked_at > after || after < before {
        return Err(failure("TLS_CERTIFICATE_TIME_INVALID"));
    }
    if require_ca {
        let mut ca = false;
        let mut extensions_seen = false;
        let mut oids = std::collections::BTreeSet::new();
        for item in tbs.iter().skip(version + 6) {
            if !matches!(item.tag(),Tag::ContextSpecific{number,..} if number.value()==3) {
                continue;
            }
            if extensions_seen {
                return Err(failure("TLS_FORMAT_INVALID"));
            }
            extensions_seen = true;
            for extension in fields(decoded(item.value())?)? {
                let fields = fields(extension)?;
                if !(2..=3).contains(&fields.len())
                    || fields[0].tag() != Tag::ObjectIdentifier
                    || fields.last().unwrap().tag() != Tag::OctetString
                    || !oids.insert(fields[0].value())
                {
                    return Err(failure("TLS_FORMAT_INVALID"));
                }
                if fields.len() == 3 {
                    fields[1]
                        .decode_as::<bool>()
                        .map_err(|_| failure("TLS_FORMAT_INVALID"))?;
                }
                let value = decoded(fields.last().unwrap().value())?;
                match fields[0].value() {
                    [0x55, 0x1d, 0x13] => {
                        let constraints = self::fields(value)?;
                        ca = constraints
                            .first()
                            .is_some_and(|v| v.decode_as::<bool>() == Ok(true));
                    }
                    [0x55, 0x1d, 0x0f] => {
                        let bits = value
                            .decode_as::<BitStringRef<'_>>()
                            .map_err(|_| failure("TLS_CHAIN_INVALID"))?;
                        if bits.raw_bytes().first().is_none_or(|b| b & 0x04 == 0) {
                            return Err(failure("TLS_CHAIN_INVALID"));
                        }
                    }
                    _ => {}
                }
            }
        }
        if !ca {
            return Err(failure("TLS_CHAIN_INVALID"));
        }
    }
    Ok(after)
}
