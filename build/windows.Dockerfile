# Cross-compiles the AudioTag Windows installer (NSIS .exe) from Linux using
# cargo-xwin. This image builds the installer during `docker build`; the
# release script then copies it out with `docker cp`.
#
# Note: only NSIS (-setup.exe) installers can be cross-compiled. MSI/WiX
# installers can only be produced on Windows. macOS installers cannot be built
# in a container at all and are built natively by scripts/release.sh.
FROM rust:1-bookworm

# Toolchain for the MSVC cross target (clang/lld), the NSIS bundler, and node.
RUN apt-get update && apt-get install -y --no-install-recommends \
        clang lld llvm nsis ca-certificates curl git \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@9 --activate

# Windows target + cargo-xwin (downloads the Windows SDK/CRT on first build).
RUN rustup target add x86_64-pc-windows-msvc \
    && cargo install --locked cargo-xwin

WORKDIR /app
COPY . .

# Install JS deps and cross-compile the NSIS installer. `pnpm exec` invokes the
# Tauri CLI directly so the --runner flag isn't swallowed by pnpm.
RUN pnpm install --frozen-lockfile \
    && pnpm exec tauri build \
        --runner cargo-xwin \
        --target x86_64-pc-windows-msvc \
        --bundles nsis

# Installer is left at:
#   /app/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe
