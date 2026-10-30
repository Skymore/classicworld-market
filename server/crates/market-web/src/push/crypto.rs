//! RFC 8291 message encryption (`aes128gcm`, a single record) and RFC 8292
//! VAPID (ES256) for Web Push.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes128Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hkdf::Hkdf;
use p256::{
    ecdh::diffie_hellman,
    ecdsa::{signature::Signer, Signature, SigningKey},
    elliptic_curve::sec1::ToEncodedPoint,
    PublicKey, SecretKey,
};
use serde_json::json;
use sha2::Sha256;

/// Record size written into the header (RFC 8188 §2.1).
const RECORD_SIZE: u32 = 4096;
/// Uncompressed P-256 point: 0x04 || x || y.
pub const PUBLIC_KEY_LEN: usize = 65;
pub const AUTH_SECRET_LEN: usize = 16;
/// salt(16) + rs(4) + idlen(1) + keyid(65).
const HEADER_LEN: usize = 86;
/// RFC 8291 §4: a push message body is at most 4096 octets, so one record
/// carries at most 4096 - 86 (header) - 16 (tag) - 1 (delimiter) octets.
pub const MAX_PLAINTEXT: usize = 3993;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    #[error("invalid key")]
    InvalidKey,
    #[error("payload too large")]
    PayloadTooLarge,
    #[error("message could not be decrypted")]
    Decrypt,
}

/// A browser subscription key: an uncompressed point that lies on P-256.
pub fn subscriber_key(bytes: &[u8]) -> Result<PublicKey, CryptoError> {
    if bytes.len() != PUBLIC_KEY_LEN || bytes[0] != 0x04 {
        return Err(CryptoError::InvalidKey);
    }
    PublicKey::from_sec1_bytes(bytes).map_err(|_| CryptoError::InvalidKey)
}

pub fn encode_public(key: &PublicKey) -> [u8; PUBLIC_KEY_LEN] {
    key.to_encoded_point(false)
        .as_bytes()
        .try_into()
        .expect("uncompressed P-256 point")
}

/// A fresh P-256 private key from the operating system RNG.
pub fn random_secret() -> SecretKey {
    loop {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).expect("operating system RNG");
        // Rejects only zero or values >= the group order (probability ~2^-32).
        if let Ok(key) = SecretKey::from_slice(&bytes) {
            return key;
        }
    }
}

/// RFC 8291 §3.3-3.4: the content encryption key and nonce.
fn content_keys(
    ecdh_secret: &[u8],
    auth: &[u8],
    ua_public: &[u8; PUBLIC_KEY_LEN],
    as_public: &[u8; PUBLIC_KEY_LEN],
    salt: &[u8],
) -> ([u8; 16], [u8; 12]) {
    let mut key_info = Vec::with_capacity(14 + 2 * PUBLIC_KEY_LEN);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), ecdh_secret)
        .expand(&key_info, &mut ikm)
        .expect("32-byte HKDF output");
    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .expect("16-byte HKDF output");
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .expect("12-byte HKDF output");
    (cek, nonce)
}

/// Encrypts `plaintext` for one subscriber with a given sender key and salt.
/// Production code uses [`encrypt`]; fixed inputs reproduce RFC 8291 Appendix A.
pub fn encrypt_with(
    plaintext: &[u8],
    ua_public: &PublicKey,
    auth: &[u8],
    sender: &SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>, CryptoError> {
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(CryptoError::PayloadTooLarge);
    }
    if auth.len() != AUTH_SECRET_LEN {
        return Err(CryptoError::InvalidKey);
    }
    let ua_bytes = encode_public(ua_public);
    let as_bytes = encode_public(&sender.public_key());
    let shared = diffie_hellman(sender.to_nonzero_scalar(), ua_public.as_affine());
    let (cek, nonce) = content_keys(shared.raw_secret_bytes(), auth, &ua_bytes, &as_bytes, salt);
    let mut record = Vec::with_capacity(plaintext.len() + 1);
    record.extend_from_slice(plaintext);
    record.push(0x02); // last-record padding delimiter, no padding
    let sealed = Aes128Gcm::new_from_slice(&cek)
        .expect("16-byte key")
        .encrypt(Nonce::from_slice(&nonce), record.as_slice())
        .map_err(|_| CryptoError::PayloadTooLarge)?;
    let mut body = Vec::with_capacity(HEADER_LEN + sealed.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(PUBLIC_KEY_LEN as u8);
    body.extend_from_slice(&as_bytes);
    body.extend_from_slice(&sealed);
    Ok(body)
}

/// Encrypts with a new sender key and salt for every message.
pub fn encrypt(
    plaintext: &[u8],
    ua_public: &PublicKey,
    auth: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).expect("operating system RNG");
    encrypt_with(plaintext, ua_public, auth, &random_secret(), &salt)
}

/// The receiving browser's side of [`encrypt`]; used by tests and local fakes.
pub fn decrypt(body: &[u8], ua_private: &SecretKey, auth: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if body.len() < HEADER_LEN + 17 || body[20] as usize != PUBLIC_KEY_LEN {
        return Err(CryptoError::Decrypt);
    }
    let (salt, as_bytes) = (&body[..16], &body[21..HEADER_LEN]);
    let as_public = subscriber_key(as_bytes).map_err(|_| CryptoError::Decrypt)?;
    let ua_bytes = encode_public(&ua_private.public_key());
    let shared = diffie_hellman(ua_private.to_nonzero_scalar(), as_public.as_affine());
    let (cek, nonce) = content_keys(
        shared.raw_secret_bytes(),
        auth,
        &ua_bytes,
        as_bytes.try_into().expect("65 bytes"),
        salt,
    );
    let mut record = Aes128Gcm::new_from_slice(&cek)
        .expect("16-byte key")
        .decrypt(Nonce::from_slice(&nonce), &body[HEADER_LEN..])
        .map_err(|_| CryptoError::Decrypt)?;
    // Strip padding up to the last-record delimiter.
    while let Some(byte) = record.pop() {
        match byte {
            0x00 => continue,
            0x02 => return Ok(record),
            _ => break,
        }
    }
    Err(CryptoError::Decrypt)
}

/// The application server key (VAPID, RFC 8292).
#[derive(Clone)]
pub struct VapidKey {
    signing: SigningKey,
    public: [u8; PUBLIC_KEY_LEN],
}

impl VapidKey {
    pub fn generate() -> Self {
        Self::from_secret(random_secret())
    }

    /// A raw 32-byte P-256 private scalar.
    pub fn from_private(bytes: &[u8]) -> Result<Self, CryptoError> {
        // `from_slice` would left-pad shorter input.
        if bytes.len() != 32 {
            return Err(CryptoError::InvalidKey);
        }
        SecretKey::from_slice(bytes)
            .map(Self::from_secret)
            .map_err(|_| CryptoError::InvalidKey)
    }

    fn from_secret(secret: SecretKey) -> Self {
        Self {
            public: encode_public(&secret.public_key()),
            signing: SigningKey::from(secret),
        }
    }

    pub fn private_bytes(&self) -> [u8; 32] {
        self.signing.to_bytes().into()
    }

    pub fn public_key(&self) -> &[u8; PUBLIC_KEY_LEN] {
        &self.public
    }

    pub fn public_base64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.public)
    }

    /// An ES256 JWT for one push service origin.
    pub fn jwt(&self, audience: &str, subject: &str, expires_at: u64) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = URL_SAFE_NO_PAD
            .encode(json!({"aud": audience, "exp": expires_at, "sub": subject}).to_string());
        let input = format!("{header}.{claims}");
        let signature: Signature = self.signing.sign(input.as_bytes());
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    /// The `Authorization` header value (RFC 8292 §3).
    pub fn authorization(&self, audience: &str, subject: &str, expires_at: u64) -> String {
        format!(
            "vapid t={}, k={}",
            self.jwt(audience, subject, expires_at),
            self.public_base64()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(value: &str) -> Vec<u8> {
        let compact: String = value.split_whitespace().collect();
        URL_SAFE_NO_PAD.decode(compact).unwrap()
    }

    // RFC 8291 Section 5 and Appendix A.
    const PLAINTEXT: &str = "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24";
    const AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const AS_PUBLIC: &str =
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const UA_PRIVATE: &str = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    const UA_PUBLIC: &str =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const BODY: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
        mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
        pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

    #[test]
    fn rfc8291_appendix_a_intermediate_values_and_message() {
        let sender = SecretKey::from_slice(&b64(AS_PRIVATE)).unwrap();
        let receiver = SecretKey::from_slice(&b64(UA_PRIVATE)).unwrap();
        assert_eq!(encode_public(&sender.public_key()).to_vec(), b64(AS_PUBLIC));
        assert_eq!(
            encode_public(&receiver.public_key()).to_vec(),
            b64(UA_PUBLIC)
        );
        let ua_public = subscriber_key(&b64(UA_PUBLIC)).unwrap();
        let shared = diffie_hellman(sender.to_nonzero_scalar(), ua_public.as_affine());
        assert_eq!(
            shared.raw_secret_bytes().to_vec(),
            b64("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs")
        );
        let (cek, nonce) = content_keys(
            shared.raw_secret_bytes(),
            &b64(AUTH),
            b64(UA_PUBLIC).as_slice().try_into().unwrap(),
            b64(AS_PUBLIC).as_slice().try_into().unwrap(),
            &b64(SALT),
        );
        assert_eq!(cek.to_vec(), b64("oIhVW04MRdy2XN9CiKLxTg"));
        assert_eq!(nonce.to_vec(), b64("4h_95klXJ5E_qnoN"));
        let salt: [u8; 16] = b64(SALT).try_into().unwrap();
        let body = encrypt_with(&b64(PLAINTEXT), &ua_public, &b64(AUTH), &sender, &salt).unwrap();
        assert_eq!(body, b64(BODY));
        assert_eq!(
            &body[..HEADER_LEN],
            b64(
                "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
            mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8"
            )
            .as_slice()
        );
        assert_eq!(
            &body[HEADER_LEN..],
            b64("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ")
                .as_slice()
        );
        assert_eq!(
            decrypt(&body, &receiver, &b64(AUTH)).unwrap(),
            b"When I grow up, I want to be a watermelon"
        );
    }

    #[test]
    fn random_encryption_round_trips_and_rejects_tampering_and_wrong_secret() {
        let receiver = random_secret();
        let auth = [7u8; 16];
        let body = encrypt(b"{\"title\":\"x\"}", &receiver.public_key(), &auth).unwrap();
        assert_eq!(
            decrypt(&body, &receiver, &auth).unwrap(),
            b"{\"title\":\"x\"}"
        );
        let other = encrypt(b"{\"title\":\"x\"}", &receiver.public_key(), &auth).unwrap();
        assert_ne!(body, other, "a fresh sender key and salt per message");
        assert_eq!(
            decrypt(&body, &receiver, &[8u8; 16]),
            Err(CryptoError::Decrypt)
        );
        let mut tampered = body.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(
            decrypt(&tampered, &receiver, &auth),
            Err(CryptoError::Decrypt)
        );
        let largest = vec![b'a'; MAX_PLAINTEXT];
        assert_eq!(
            encrypt(&largest, &receiver.public_key(), &auth)
                .unwrap()
                .len(),
            4096
        );
        assert_eq!(
            encrypt(&[0; MAX_PLAINTEXT + 1], &receiver.public_key(), &auth),
            Err(CryptoError::PayloadTooLarge)
        );
    }

    #[test]
    fn subscriber_keys_must_be_uncompressed_points_on_the_curve() {
        let valid = b64(UA_PUBLIC);
        assert!(subscriber_key(&valid).is_ok());
        let mut off_curve = valid.clone();
        off_curve[64] ^= 1;
        assert_eq!(subscriber_key(&off_curve), Err(CryptoError::InvalidKey));
        assert_eq!(subscriber_key(&valid[..33]), Err(CryptoError::InvalidKey));
        let compressed = random_secret().public_key().to_encoded_point(true);
        assert_eq!(
            subscriber_key(compressed.as_bytes()),
            Err(CryptoError::InvalidKey)
        );
        assert_eq!(subscriber_key(&[0u8; 65]), Err(CryptoError::InvalidKey));
    }

    #[test]
    fn vapid_jwt_verifies_with_the_public_key_only() {
        use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
        let key = VapidKey::generate();
        let restored = VapidKey::from_private(&key.private_bytes()).unwrap();
        assert_eq!(restored.public_key(), key.public_key());
        let header = key.authorization(
            "https://fcm.googleapis.com",
            "https://mxd.ruit.me",
            4_000_000_000,
        );
        let (token, public) = header
            .strip_prefix("vapid t=")
            .unwrap()
            .split_once(", k=")
            .unwrap();
        assert_eq!(public, key.public_base64());
        let point = URL_SAFE_NO_PAD.decode(public).unwrap();
        let verifier = DecodingKey::from_ec_components(
            &URL_SAFE_NO_PAD.encode(&point[1..33]),
            &URL_SAFE_NO_PAD.encode(&point[33..]),
        )
        .unwrap();
        let mut rules = Validation::new(Algorithm::ES256);
        rules.set_audience(&["https://fcm.googleapis.com"]);
        rules.set_required_spec_claims(&["exp", "aud", "sub"]);
        let claims = decode::<serde_json::Value>(token, &verifier, &rules)
            .unwrap()
            .claims;
        assert_eq!(claims["sub"], "https://mxd.ruit.me");
        assert_eq!(claims["exp"], 4_000_000_000u64);
        let other = VapidKey::generate().public_base64();
        let point = URL_SAFE_NO_PAD.decode(other).unwrap();
        let wrong = DecodingKey::from_ec_components(
            &URL_SAFE_NO_PAD.encode(&point[1..33]),
            &URL_SAFE_NO_PAD.encode(&point[33..]),
        )
        .unwrap();
        assert!(decode::<serde_json::Value>(token, &wrong, &rules).is_err());
        assert!(VapidKey::from_private(&[0u8; 32]).is_err());
        assert!(VapidKey::from_private(&[1u8; 31]).is_err());
    }
}
