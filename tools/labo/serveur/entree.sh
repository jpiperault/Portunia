#!/bin/sh
# Démarrage d'un serveur du labo. Variables : ANCIEN, DEUX_FACTEURS, TELNET (« 1 » pour activer).
set -e

# Nouvelles clés d'hôte à chaque nouveau conteneur (test « clé de serveur changée »).
ssh-keygen -A >/dev/null
mkdir -p /run/sshd

# Clés publiques déposées dans tools/labo/cles : autorisées pour le compte test.
if ls /cles/*.pub >/dev/null 2>&1; then
  cat /cles/*.pub > /home/test/.ssh/authorized_keys
  chown test:test /home/test/.ssh/authorized_keys
  chmod 600 /home/test/.ssh/authorized_keys
fi

# Docker du labo visible par le compte test (socket monté, groupe repris de son propriétaire).
if [ -S /var/run/docker.sock ]; then
  gid=$(stat -c %g /var/run/docker.sock)
  group=$(getent group "$gid" | cut -d: -f1)
  if [ -z "$group" ]; then groupadd -g "$gid" dockerhote; group=dockerhote; fi
  usermod -aG "$group" test
fi

# Vieil équipement : seulement des algorithmes anciens.
if [ "$ANCIEN" = "1" ]; then
  cat > /etc/ssh/sshd_config.d/ancien.conf <<EOF
KexAlgorithms diffie-hellman-group14-sha1
HostKeyAlgorithms ssh-rsa
PubkeyAcceptedAlgorithms +ssh-rsa
Ciphers aes128-cbc
MACs hmac-sha1
EOF
fi

# Double authentification : mot de passe, puis code TOTP (secret fixe, voir LISEZMOI).
if [ "$DEUX_FACTEURS" = "1" ]; then
  printf 'JBSWY3DPEHPK3PXP\n" TOTP_AUTH\n' > /home/test/.google_authenticator
  chown test:test /home/test/.google_authenticator
  chmod 400 /home/test/.google_authenticator
  grep -q pam_google_authenticator /etc/pam.d/sshd \
    || sed -i 's/^@include common-auth$/@include common-auth\nauth required pam_google_authenticator.so/' /etc/pam.d/sshd
  cat > /etc/ssh/sshd_config.d/zz-deux-facteurs.conf <<EOF
PasswordAuthentication no
PubkeyAuthentication no
KbdInteractiveAuthentication yes
UsePAM yes
AuthenticationMethods keyboard-interactive
EOF
fi

# Telnet (non chiffré) pour le test du protocole Telnet.
if [ "$TELNET" = "1" ]; then
  echo 'telnet stream tcp nowait root /usr/sbin/telnetd telnetd' > /etc/inetd.conf
  /usr/sbin/inetd
fi

exec /usr/sbin/sshd -D -e
