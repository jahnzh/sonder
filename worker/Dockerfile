FROM python:3.10-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir 'numpy==1.26.4' 'fastapi==0.121.3' 'uvicorn==0.38.0' 'psutil==7.1.3'
COPY requirements-ctc.txt /worker/requirements-ctc.txt
RUN pip install --no-cache-dir -r /worker/requirements-ctc.txt
WORKDIR /worker
# The service and the model download only; research and gate scripts stay out of the image.
COPY align.py book_*.py ctc_*.py deadline.py download_model.py /worker/
ENV PYTHONUNBUFFERED=1 OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2
EXPOSE 3012
CMD ["uvicorn", "align:app", "--host", "0.0.0.0", "--port", "3012", "--no-access-log"]
