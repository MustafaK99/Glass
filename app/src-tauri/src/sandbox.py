"""Glass's driver for Mirror's sandbox workspaces.

Every step is Mirror's own code from the installed `reflection-mirror`: the
pinned, checksum-verified runtime and image downloads (`mirror.cli.sandbox.setup`),
the private clone (`mirror.cli.sandboxes`), and preparing the VM
(`mirror.cli.sandbox_shell.SandboxShell.prepare`). Glass picks the step and passes
paths; it never downloads, clones or starts a VM itself.

    sandbox.py status
    sandbox.py install                  install the pinned runtime, after consent
    sandbox.py download                 pull the pinned image and guest tools, after consent
    sandbox.py create WORKER SOURCE NAME   SOURCE and NAME may be "-"
    sandbox.py env                      the worker's VM environment
    sandbox.py stop|delete WORKER ID
    sandbox.py remove-clone PATH

Each command prints one JSON line on success.
"""

import asyncio
import json
import pathlib
import platform
import subprocess
import sys

from mirror import config
from mirror.cli import sandbox_shell, sandboxes
from mirror.cli.sandbox import setup


def _settings() -> config.Config:
  return config.Config(config.default_path())


def _options() -> setup.Options:
  return setup.Options.load(_settings().read())


def status() -> dict[str, object]:
  options = _options()
  executable, library = setup.runtime_artifacts() if platform.system() in ('Darwin', 'Linux') else (None, None)
  image, image_size = setup.default_image()
  return {
    'checks': [[label, ok] for label, ok in options.checks()],
    'host_ok': all(ok for _, ok in setup.host_checks()),
    'runtime_ready': options.runtime_ready(),
    'image_ready': options.image_ready(),
    'image': options.image,
    'downloads': {
      'runtime': [
        {'url': artifact.url, 'size': artifact.size}
        for artifact in (executable, library)
        if artifact is not None
      ],
      'image': {'reference': image, 'size': image_size},
    },
    'root': str(sandboxes.default_root()),
  }


async def install() -> dict[str, object]:
  options = _options()
  options.executable = await setup.install_runtime()
  options.save(_settings())
  return {'executable': options.executable}


async def download() -> dict[str, object]:
  options = _options()
  await setup.prepare_image(options)
  options.save(_settings())
  return {'image': options.image}


async def _vm(worker: str, action: str, sandbox_id: str) -> None:
  completed = subprocess.run(
    (*setup.worker_command((worker,)), 'sandbox', action, sandbox_id),
    stdin=subprocess.DEVNULL,
    capture_output=True,
    text=True,
  )
  if completed.returncode:
    detail = (completed.stdout + completed.stderr).strip()
    raise RuntimeError(f'could not {action} sandbox {sandbox_id}: {detail}')


async def create(worker: str, source: str, name: str) -> dict[str, object]:
  options = _options()
  if not options.runtime_ready() or not options.image_ready():
    raise RuntimeError('Set up the sandbox runtime and environment first.')
  options.save(_settings())
  sandbox = sandboxes.Sandbox.from_settings(_settings().read())
  clone, label = sandboxes.create_default_clone(
    None if source == '-' else pathlib.Path(source), None if name == '-' else name
  )
  configuration = sandbox.worker_config(sandboxes.sandboxd_path())
  try:
    await sandbox_shell.SandboxShell(
      clone, worker_command=(worker,), configuration=configuration
    ).prepare()
  except BaseException:
    try:
      await _vm(worker, 'delete', sandbox.id)
    finally:
      sandboxes.remove_clone(clone)
    raise
  return {'path': str(clone), 'name': label, 'sandbox': configuration}


def env() -> dict[str, object]:
  return setup.runtime_environment(_options())


async def main(arguments: list[str]) -> object:
  match arguments:
    case ['status']:
      return status()
    case ['install']:
      return await install()
    case ['download']:
      return await download()
    case ['create', worker, source, name]:
      return await create(worker, source, name)
    case ['env']:
      return env()
    case ['stop' | 'delete' as action, worker, sandbox_id]:
      await _vm(worker, action, sandbox_id)
      return {}
    case ['remove-clone', path]:
      root = sandboxes.default_root().resolve()
      target = pathlib.Path(path).resolve()
      if target.parent != root:
        raise RuntimeError(f'{path} is not a sandbox clone')
      sandboxes.remove_clone(target)
      return {}
  raise SystemExit(f'unknown sandbox command: {arguments}')


print(json.dumps(asyncio.run(main(sys.argv[1:]))), flush=True)
