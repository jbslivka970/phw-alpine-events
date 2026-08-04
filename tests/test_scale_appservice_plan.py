import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


class ScaleAppServicePlanScriptTests(unittest.TestCase):
    def test_capacity_argument_is_forwarded_to_az_update(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        script_path = repo_root / "scripts" / "scale-appservice-plan.sh"

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
                    exit 0
                    """
                ).strip()
                + "\n"
            )
            fake_az.chmod(0o755)

            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env['PATH']}"
            env["AZURE_RESOURCE_GROUP"] = "rg"
            env["AZURE_APP_SERVICE_PLAN_NAME"] = "plan"
            env["AZURE_APP_SERVICE_PLAN_SKU"] = "B1"
            env["AZURE_APP_SERVICE_PLAN_CAPACITY"] = "1"

            result = subprocess.run(
                [
                    "bash",
                    str(script_path),
                    "--resource-group",
                    "rg",
                    "--plan-name",
                    "plan",
                    "--sku",
                    "P1v3",
                    "--capacity",
                    "3",
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
                any("--number-of-workers" in line and "3" in line for line in logged),
                msg=f"expected worker count argument to be forwarded, got: {logged}",
            )


if __name__ == "__main__":
    unittest.main()
