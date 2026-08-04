import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


class EnsureWebAppScriptTests(unittest.TestCase):
    def test_linux_free_tier_plan_and_webapp_are_created(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        script_path = repo_root / "scripts" / "ensure-webapp.sh"

        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_bin = Path(tmp_dir) / "bin"
            fake_bin.mkdir(parents=True, exist_ok=True)
            log_path = Path(tmp_dir) / "az.log"
            fake_az = fake_bin / "az"
            fake_az.write_text(
                textwrap.dedent(
                    f"""
                    #!/usr/bin/env bash
                    echo "$@" >> "{log_path}"
                    if [[ "$1" == "appservice" && "$2" == "plan" && "$3" == "show" ]]; then
                      exit 1
                    fi
                    if [[ "$1" == "webapp" && "$2" == "show" ]]; then
                      exit 1
                    fi
                    exit 0
                    """
                ).strip()
                + "\n"
            )
            fake_az.chmod(0o755)

            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env['PATH']}"

            result = subprocess.run(
                [
                    "bash",
                    str(script_path),
                    "--resource-group",
                    "rg",
                    "--app-name",
                    "splash",
                    "--plan-name",
                    "plan",
                    "--plan-sku",
                    "F1",
                    "--os",
                    "linux",
                    "--runtime",
                    "NODE|20-lts",
                ],
                cwd=repo_root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, msg=result.stderr)
            self.assertTrue(log_path.exists(), "expected az stub to log command args")
            logged = log_path.read_text().strip().splitlines()
            self.assertTrue(
                any(line.startswith("appservice plan create") for line in logged),
                msg=f"expected plan create command, got: {logged}",
            )
            self.assertTrue(
                any("--is-linux" in line for line in logged),
                msg=f"expected linux plan flag, got: {logged}",
            )
            self.assertTrue(
                any(line.startswith("webapp create") for line in logged),
                msg=f"expected webapp create command, got: {logged}",
            )
            self.assertTrue(
                any("NODE|20-lts" in line for line in logged),
                msg=f"expected runtime to be forwarded, got: {logged}",
            )


if __name__ == "__main__":
    unittest.main()
