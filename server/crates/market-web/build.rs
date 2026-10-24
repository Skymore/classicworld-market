fn main() {
    // SQLx expands migrations at compile time; stable Rust otherwise does not
    // necessarily rebuild this crate when only migration files change.
    println!("cargo:rerun-if-changed=../../migrations");
}
