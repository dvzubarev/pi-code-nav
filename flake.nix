{
  description = "code-nav — LSP-backed code navigation extension for pi";

  inputs.nixpkgs.url = "nixpkgs";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config = { allowUnfree = true; };
      };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        buildInputs = [
          # Node toolchain for the extension itself
          pkgs.nodejs_22

          # Language servers — used by the extension at runtime.
          # Users provide these in their own project shells; they are here
          # for development/testing of the extension.
          pkgs.ccls
          pkgs.ty
          pkgs.pyright
          pkgs.bash-language-server
        ];

        shellHook = ''
          echo "code-nav dev shell"
          echo "  npm install   — install node dependencies"
          echo "  npm test      — run unit tests"
          echo "  npm run check — type-check with tsc"
          echo "  ./install.sh  — symlink into ~/.pi/agent/extensions/code-nav/"
        '';
      };
    };
}
