{
  description = "Description for the project";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      perSystem =
        {
          config,
          self',
          inputs',
          pkgs,
          system,
          lib,
          ...
        }:
        {
          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.nixfmt
              pkgs.nodejs_22
              pkgs.pnpm_9
            ];
          };
          packages.firefox-dev = pkgs.firefox-devedition.override {
            extraPolicies = {
              BlockAboutConfig = true;
              "3rdparty".Extensions."{7a7a4a92-a2a0-41d1-9fd7-1e92480d612d}" = {
                prefs.patchCsp = true;
                prefs.updateInterval = 0;
                styles = [
                  {
                    code = builtins.readFile ./example-userstyle.user.less;
                    variables.accentColor = "red";
                  }
                ];
              };
            };
          };
        };
    };
}
