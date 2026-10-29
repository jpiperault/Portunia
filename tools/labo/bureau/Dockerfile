# Bureau Linux léger accessible en VNC (mot de passe : portunia).
FROM debian:bookworm-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox xterm x11-apps \
 && rm -rf /var/lib/apt/lists/*

COPY entree.sh /entree.sh
RUN chmod +x /entree.sh
EXPOSE 5901
ENTRYPOINT ["/entree.sh"]
