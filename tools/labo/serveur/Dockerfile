# Serveur Linux de test : OpenSSH, sudo, outils courants, X11, telnet, double authentification.
FROM debian:bookworm-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server sudo procps htop vim-tiny less curl ca-certificates python3 \
      xauth x11-apps libpam-google-authenticator oathtool openbsd-inetd inetutils-telnetd \
 && rm -rf /var/lib/apt/lists/*

# Client Docker seul (le moteur est celui de Docker Desktop, via le socket monté).
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.3.1.tgz \
    | tar -xz -C /usr/local/bin --strip-components=1 docker/docker

# Compte de test : test / portunia-test, sudo sans mot de passe.
RUN useradd -m -s /bin/bash test \
 && echo 'test:portunia-test' | chpasswd \
 && echo 'test ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/test \
 && mkdir -p /home/test/.ssh && chmod 700 /home/test/.ssh && chown -R test:test /home/test/.ssh

COPY labo.conf /etc/ssh/sshd_config.d/labo.conf
COPY entree.sh /entree.sh
RUN chmod +x /entree.sh

EXPOSE 22 23
ENTRYPOINT ["/entree.sh"]
