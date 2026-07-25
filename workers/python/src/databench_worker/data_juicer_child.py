from __future__ import annotations

import argparse
import socket
import sys


def _network_disabled(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202, ARG001
    raise OSError("network access is disabled for Data-Juicer")


_socket_connect = socket.socket.connect


def _connect_local_only(self, address):  # noqa: ANN001, ANN202
    if self.family != socket.AF_UNIX:
        return _network_disabled(self, address)
    return _socket_connect(self, address)


def _runtime_install_disabled(cls, *args, **kwargs):  # noqa: ANN002, ANN003, ANN202, ARG001
    raise ImportError("runtime dependency installation is disabled")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    socket.create_connection = _network_disabled
    socket.getaddrinfo = _network_disabled
    socket.socket.connect = _connect_local_only
    socket.socket.connect_ex = _network_disabled

    from data_juicer.utils.lazy_loader import LazyLoader

    LazyLoader._install_package = classmethod(_runtime_install_disabled)

    from data_juicer.tools.process_data import main as process_data

    sys.argv = ["dj-process", "--config", args.config]
    process_data()


if __name__ == "__main__":
    main()
