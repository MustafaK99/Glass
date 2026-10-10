//! Compiles Mirror's protocol files with a pure-Rust compiler, so no `protoc` install is needed.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto");
    let files = ["mirror/protocol/agent.proto", "mirror/protocol/mirror.proto"];
    for file in &files {
        println!("cargo:rerun-if-changed={}", root.join(file).display());
    }
    let descriptors = protox::compile(files, [&root])?;
    tonic_prost_build::configure()
        .build_server(false)
        .compile_fds(descriptors)?;
    Ok(())
}
